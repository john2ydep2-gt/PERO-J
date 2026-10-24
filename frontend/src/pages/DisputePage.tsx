import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchDispute, type DisputeDetail } from '../api';

const POLL_INTERVAL_MS = 5000;

function shortenAddress(address: string): string {
  if (!address) return '';
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatBond(bond: string | number | undefined): string {
  if (bond === undefined || bond === null || bond === '') return '—';
  return `${bond} XLM`;
}

function formatDeadline(deadline: string | undefined): string {
  if (!deadline) return '—';
  const date = new Date(deadline);
  if (Number.isNaN(date.getTime())) return deadline;
  return date.toLocaleString();
}

function DisputePage() {
  const { marketId } = useParams<{ marketId: string }>();
  const [dispute, setDispute] = useState<DisputeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!marketId) return;
    let cancelled = false;

    const load = async () => {
      try {
        const data = await fetchDispute(marketId);
        if (!cancelled) {
          setDispute(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load dispute');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [marketId]);

  const voteProgress = useMemo(() => {
    if (!dispute) return { cast: 0, total: 0, percent: 0 };
    const cast = dispute.councilVotes?.length ?? 0;
    const total = dispute.councilSize ?? 0;
    const percent = total > 0 ? Math.min(100, Math.round((cast / total) * 100)) : 0;
    return { cast, total, percent };
  }, [dispute]);

  if (loading) {
    return (
      <div className="dispute-page">
        <p>Loading dispute…</p>
      </div>
    );
  }

  if (error || !dispute) {
    return (
      <div className="dispute-page">
        <p className="dispute-error">{error ?? 'Dispute not found'}</p>
      </div>
    );
  }

  return (
    <div className="dispute-page">
      <h1>Dispute for Market {marketId}</h1>

      <section className="dispute-parties">
        <div className="dispute-party">
          <h2>Submitter</h2>
          <p title={dispute.submitter}>Address: {shortenAddress(dispute.submitter)}</p>
          <p>Proposed outcome: {dispute.proposedOutcome}</p>
          <p>Bond posted: {formatBond(dispute.submitterBond)}</p>
        </div>
        <div className="dispute-party">
          <h2>Challenger</h2>
          <p title={dispute.challenger}>Address: {shortenAddress(dispute.challenger)}</p>
          <p>Disputed outcome: {dispute.disputedOutcome}</p>
          <p>Bond posted: {formatBond(dispute.challengerBond)}</p>
        </div>
      </section>

      <section className="dispute-votes">
        <h2>Council Votes</h2>
        <p>
          {voteProgress.cast} of {voteProgress.total} votes reached
        </p>
        <div
          className="dispute-vote-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={voteProgress.total}
          aria-valuenow={voteProgress.cast}
        >
          <div className="dispute-vote-bar-fill" style={{ width: `${voteProgress.percent}%` }} />
        </div>
        {dispute.councilVotes && dispute.councilVotes.length > 0 && (
          <ul className="dispute-vote-list">
            {dispute.councilVotes.map((vote) => (
              <li key={vote.voter}>
                {shortenAddress(vote.voter)} voted {vote.outcome}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="dispute-evidence">
        <h2>Evidence &amp; Deadline</h2>
        <p>Resolution deadline: {formatDeadline(dispute.resolutionDeadline)}</p>
        {dispute.evidenceLinks && dispute.evidenceLinks.length > 0 ? (
          <ul>
            {dispute.evidenceLinks.map((link) => (
              <li key={link}>
                <a href={link} target="_blank" rel="noopener noreferrer">
                  {link}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p>No evidence submitted.</p>
        )}
      </section>

      <section className="dispute-timeline">
        <h2>Timeline</h2>
        {dispute.timeline && dispute.timeline.length > 0 ? (
          <ol className="dispute-timeline-list">
            {dispute.timeline.map((event, index) => (
              <li key={`${event.timestamp}-${index}`}>
                <span className="dispute-timeline-time">{formatDeadline(event.timestamp)}</span>
                <span className="dispute-timeline-label">{event.label}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p>No dispute history yet.</p>
        )}
      </section>
    </div>
  );
}

export default DisputePage;
