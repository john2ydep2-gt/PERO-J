# Database Backup & Restore

> **Tranche 3 — Requirement 3.2:** *"PostgreSQL hosted with daily backups"*

---

## Overview

All decoded event history and registered ABI metadata is stored in PostgreSQL.
Without a backup strategy, this data is permanently lost on database failure.

This document covers:
- Automated backup script (`scripts/backup.sh`)
- Cron job setup for daily backups
- Restore procedure
- Cloud deployment considerations (RDS / Cloud SQL)

---

## Backup Script

### Location

[`scripts/backup.sh`](../scripts/backup.sh)

### What it does

1. Runs `pg_dump` with `--clean` and `--no-owner` against the configured database
2. Compresses the output with `gzip`
3. Saves to a timestamped file: `soroban_explorer_YYYYMMDD_HHMMSS.sql.gz`
4. Removes backups older than the configured retention period (default: 7 days)

### Usage

```bash
# Default: reads DATABASE_URL from environment, saves to ./backups/
./scripts/backup.sh

# Explicit connection + custom backup directory
DATABASE_URL="postgres://user:password@localhost:5432/soroban_explorer" \
BACKUP_DIR="/mnt/backups" \
RETENTION_DAYS=14 \
./scripts/backup.sh
```

### Environment variables

| Variable         | Default                                              | Description                         |
|------------------|------------------------------------------------------|-------------------------------------|
| `DATABASE_URL`   | `postgres://user:password@localhost:5432/soroban_explorer` | PostgreSQL connection string  |
| `BACKUP_DIR`     | `./backups/`                                         | Directory to store backup files     |
| `RETENTION_DAYS` | `7`                                                  | Number of days to keep backups      |

---

## Automated Daily Backup (Cron)

Add the following line to the `postgres` user's crontab (or any user with
read access to the database and write access to `BACKUP_DIR`):

```cron
0 2 * * * /path/to/PERO-J/scripts/backup.sh >> /var/log/backup.log 2>&1
```

This runs the backup every day at 02:00 and appends output to `/var/log/backup.log`.

### One-time setup

```bash
# Make the script executable
chmod +x scripts/backup.sh

# Create the log file
sudo touch /var/log/backup.log
sudo chown "$USER": /var/log/backup.log

# Add the cron job
crontab -e
# → paste: 0 2 * * * /path/to/PERO-J/scripts/backup.sh >> /var/log/backup.log 2>&1
```

---

## Restore Procedure

### Restore from a local backup file

```bash
# Decompress and restore
gunzip -c backups/soroban_explorer_20250301_020000.sql.gz | psql "$DATABASE_URL"
```

### Restore the latest backup

```bash
LATEST=$(ls -t backups/soroban_explorer_*.sql.gz | head -1)
echo "Restoring: $LATEST"
gunzip -c "$LATEST" | psql "$DATABASE_URL"
```

### Restore to a different database

```bash
# Create the target database first
createdb -U user -h host soroban_explorer_restore

# Restore
gunzip -c backups/soroban_explorer_latest.sql.gz |
  psql "postgres://user:password@host:5432/soroban_explorer_restore"
```

---

## Cloud Deployments (RDS / Cloud SQL)

### AWS RDS

Automated backups are enabled by default with a 7-day retention period.

**To verify or modify:**
1. Open the [RDS Console](https://console.aws.amazon.com/rds/)
2. Select your database instance
3. Under **Maintenance & Backups**, confirm:
   - **Automated backups**: Enabled
   - **Backup retention period**: 7–35 days
   - **Backup window**: choose an off-peak window

**Manual snapshot (before risky operations):**
```bash
aws rds create-db-snapshot \
  --db-instance-identifier soroban-explorer \
  --db-snapshot-identifier soroban-explorer-pre-deploy-$(date +%Y%m%d)
```

### Google Cloud SQL

Automated backups are enabled by default with a 7-day retention.

**To configure:**
1. Open the [Cloud SQL Console](https://console.cloud.google.com/sql/)
2. Select your instance → **Backups** tab
3. Enable **Automated backups** and set a preferred window

**Manual backup:**
```bash
gcloud sql backups create --instance soroban-explorer \
  --description "pre-deploy backup $(date +%Y%m%d)"
```

### Azure Database for PostgreSQL

Automated backups are enabled by default with a 7–35 day retention.

**To configure:**
1. Open the [Azure Portal](https://portal.azure.com/)
2. Navigate to your PostgreSQL flexible server
3. Under **Settings → Backup**, set retention period and preferred window

---

## Testing Backups

Periodically verify that backups are restorable:

```bash
# Create a temporary database
createdb -U user soroban_explorer_test_restore

# Restore the latest backup into it
gunzip -c backups/soroban_explorer_latest.sql.gz |
  psql "postgres://user:password@localhost:5432/soroban_explorer_test_restore"

# Query to verify (should return data)
psql "postgres://user:password@localhost:5432/soroban_explorer_test_restore" \
  -c "SELECT count(*) FROM events;" \
  -c "SELECT count(*) FROM contracts;"

# Clean up
dropdb -U user soroban_explorer_test_restore
```

## Minimum Dump Size

The backup script verifies that the dump file is larger than 512 bytes before reporting success. If the dump is too small (e.g., an empty database or a failed `pg_dump`), the script removes the file and exits with a non-zero status. This prevents false-positive backups.

---

## Monitoring

- Check `/var/log/backup.log` for success/failure messages
- Set up a cron healthcheck (e.g., [healthchecks.io](https://healthchecks.io/))
  by appending `&& curl -fsS -m 10 --retry 5 -o /dev/null "$HEARTBEAT_URL"`
  to the cron command
- For RDS / Cloud SQL, enable CloudWatch / Cloud Monitoring alerts for
  backup events

---

## Quick Reference

| Action                          | Command                                                                 |
|---------------------------------|-------------------------------------------------------------------------|
| Manual backup                   | `./scripts/backup.sh`                                                   |
| Restore latest backup           | `gunzip -c \$(ls -t backups/soroban_explorer_*.sql.gz \| head -1) \| psql "\$DATABASE_URL"` |
| Daily cron                      | `0 2 * * * /path/to/scripts/backup.sh >> /var/log/backup.log 2>&1`     |
| RDS manual snapshot             | `aws rds create-db-snapshot --db-instance-identifier soroban-explorer ...` |
| Cloud SQL manual backup         | `gcloud sql backups create --instance soroban-explorer ...`             |
