# PostgreSQL Backup & Point-in-Time Recovery (PITR)

Automated backups protect all decoded event history and registered ABI metadata
stored in PostgreSQL.  Two complementary mechanisms provide full PITR coverage:

| Mechanism | What it captures | RPO | Tooling |
|-----------|-----------------|-----|---------|
| Nightly base backup (`scripts/backup.sh`) | Full database snapshot | ≤ 24 h | `pg_dump` → local + S3 |
| Continuous WAL archiving | Every committed transaction | ≤ 5 min | `archive_command` → S3 |

**RTO target:** ≤ 1 hour for a full restore on typical indexer database sizes
(< 50 GB) on a standard cloud VM.

---

## Configuration

All settings are read from environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PGHOST` | `localhost` | Database host |
| `PGPORT` | `5432` | Database port |
| `PGUSER` | `postgres` | Database user |
| `PGPASSWORD` | _(unset)_ | Database password |
| `PGDATABASE` | `soroban_explorer` | Database name |
| `BACKUP_DIR` | `./backups` | Directory where local dumps are written |
| `RETENTION_DAYS` | `7` | Delete local dumps older than this many days |
| `BACKUP_S3_BUCKET` | _(unset)_ | S3 bucket for remote upload; upload is skipped when empty |
| `BACKUP_S3_PREFIX` | `postgres-backups` | Key prefix inside the bucket |
| `BACKUP_S3_REGION` | `us-east-1` | AWS region for the bucket |

`DATABASE_URL` is parsed automatically when the individual `PG*` variables are
not explicitly set.

---

## Running a base backup

```bash
./scripts/backup.sh
```

The script:
1. Creates `${BACKUP_DIR}/${PGDATABASE}_<UTC-timestamp>.dump` in custom format
   (`-Fc`) for efficient selective restore via `pg_restore`.
2. Validates the dump is larger than 512 bytes.
3. Uploads the dump to S3 with **SSE-KMS** encryption if `BACKUP_S3_BUCKET` is
   set (requires the AWS CLI and valid credentials or an IAM role).
4. Prunes local dumps older than `RETENTION_DAYS`.

### S3 upload

Set the S3 environment variables and run the script normally:

```bash
export BACKUP_S3_BUCKET=my-backup-bucket
export BACKUP_S3_REGION=us-east-1
./scripts/backup.sh
```

The upload uses `--sse aws:kms --storage-class STANDARD_IA` for cost-efficient
encrypted at-rest storage.  Ensure the IAM role or user has at minimum:

```json
{
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:GetObject", "s3:ListBucket"],
  "Resource": [
    "arn:aws:s3:::my-backup-bucket",
    "arn:aws:s3:::my-backup-bucket/postgres-backups/*"
  ]
}
```

---

## Cron job

Schedule a daily backup at 02:00 UTC:

```cron
0 2 * * * cd /path/to/repo && ./scripts/backup.sh >> /var/log/pg-backup.log 2>&1
```

---

## WAL archiving (continuous PITR)

WAL archiving ships every completed WAL segment to remote storage shortly after
it is filled, cutting RPO from 24 hours to the WAL rotation interval
(typically 1–5 minutes under normal write load).

### 1. Enable archiving in `postgresql.conf`

```ini
wal_level = replica
archive_mode = on
archive_command = 'aws s3 cp %p s3://${BACKUP_S3_BUCKET}/wal/%f \
  --region ${BACKUP_S3_REGION} \
  --sse aws:kms \
  --no-progress && echo "archived %f"'
archive_timeout = 300   # force a segment every 5 min even on quiet servers
```

Reload PostgreSQL after changing these settings:

```bash
psql -c "SELECT pg_reload_conf();"
```

### 2. Verify archiving is working

```sql
SELECT archived_count, failed_count, last_archived_wal, last_archived_time
FROM pg_stat_archiver;
```

`failed_count` should remain 0.  `last_archived_time` should advance every few
minutes on an active server.

### 3. Point-in-time restore using WAL

Restore the base dump first (see below), then apply WAL segments up to the
desired recovery point:

```ini
# recovery.conf (Postgres < 12) or postgresql.conf (Postgres ≥ 12)
restore_command = 'aws s3 cp s3://${BACKUP_S3_BUCKET}/wal/%f %p \
  --region ${BACKUP_S3_REGION}'
recovery_target_time = '2026-10-15 14:30:00 UTC'  # example target
recovery_target_action = 'promote'
```

Start PostgreSQL; it will apply WAL until the target time and then open for
connections.

---

## Restore from base backup

1. **Stop the indexer** to prevent writes during the restore:

   ```bash
   # If using systemd:
   systemctl stop pero-j-indexer
   # Or kill the Node.js process
   ```

2. **Create a fresh database** (or drop and recreate the existing one):

   ```bash
   createdb -h "$PGHOST" -U "$PGUSER" soroban_explorer
   ```

3. **Restore** with `pg_restore`:

   ```bash
   pg_restore -h "$PGHOST" -U "$PGUSER" -d soroban_explorer \
     --no-owner --no-privileges --exit-on-error \
     ./backups/soroban_explorer_20261015T020000Z.dump
   ```

4. **Verify** the restore:

   ```bash
   psql -h "$PGHOST" -U "$PGUSER" -d soroban_explorer \
     -c "SELECT COUNT(*) FROM events; SELECT COUNT(*) FROM contracts;"
   ```

5. **Restart the indexer**.

### Restore from S3

If the local dump is unavailable, download from S3 first:

```bash
aws s3 cp \
  s3://${BACKUP_S3_BUCKET}/postgres-backups/soroban_explorer_20261015T020000Z.dump \
  ./backups/ \
  --region ${BACKUP_S3_REGION}
# Then restore as above
```

---

## Restore verification test

`scripts/backup-restore-test.sh` automates the restore-and-verify cycle.  Run
it after every base backup to confirm recoverability:

```bash
./scripts/backup-restore-test.sh
```

The script:
1. Finds the most recent dump in `BACKUP_DIR` (or uses `DUMP_FILE` if set).
2. Creates a temporary `${PGDATABASE}_restore_test` database.
3. Restores the dump into it.
4. Queries row counts for `events` and `contracts` tables.
5. Drops the test database on exit regardless of outcome.

Run it in CI or as part of a weekly scheduled job to validate backup integrity:

```cron
# Weekly restore test every Sunday at 03:00 UTC
0 3 * * 0 cd /path/to/repo && ./scripts/backup-restore-test.sh >> /var/log/pg-restore-test.log 2>&1
```

---

## Minimum dump size

`scripts/backup.sh` rejects a dump smaller than 512 bytes — an empty or
near-empty dump almost always indicates a `pg_dump` misconfiguration or a
connectivity problem rather than a genuinely empty database.

---

## Cloud-managed backup options

For cloud-hosted PostgreSQL, complement `scripts/backup.sh` with the provider's
built-in automated backups:

| Platform | Automated backups | PITR |
|----------|------------------|------|
| **AWS RDS / Aurora** | Enable *Automated backups* in the console; set retention (recommended ≥ 7 days). | Enabled when automated backups are on. |
| **Google Cloud SQL** | Instance settings → *Backups* → enable, set retention. | Enable *Point-in-time recovery* in the same panel. |
| **Supabase** | Dashboard → Project Settings → Database → Backups (paid plans). | Available on Pro+ plans. |
| **Neon** | Dashboard → Settings → Branches; Neon branches act as snapshots. | Rewind to any point within the retention window. |

For any provider, also run `scripts/backup.sh` on a schedule to produce an
independent off-site copy in your own S3 bucket.
