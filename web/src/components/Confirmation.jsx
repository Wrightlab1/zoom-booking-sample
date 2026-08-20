import { useState } from 'react';

import { formatFullDateTime } from '../time.js';

/**
 * The booking exists by the time this renders.
 *
 * `warning` carries PARTIAL_SUCCESS or NO_MEETING_LINK — cases where the
 * meeting is real but something after it did not land. These must read as
 * "booked, with a caveat", never as a failure: telling someone their booking
 * failed when it did not is how the host ends up double-booked.
 */
export default function Confirmation({ booking, timeZone, onBookAnother }) {
  const [copied, setCopied] = useState(false);
  const meeting = booking.meeting;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(meeting.joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="stack">
      <header className="step-head">
        <p className="eyebrow eyebrow--ok">Booked</p>
        <h2>You're all set</h2>
      </header>

      <div className="confirm-card">
        <div className="summary">
          <div>
            <span className="summary__label">With</span>
            <span className="summary__value">
              {booking.host?.email || booking.topic}
            </span>
          </div>
          <div>
            <span className="summary__label">When</span>
            <span className="summary__value">
              {formatFullDateTime(booking.startDateTime, timeZone)}
            </span>
          </div>
          <div>
            <span className="summary__label">Length</span>
            <span className="summary__value">{booking.durationMinutes} minutes</span>
          </div>
        </div>

        {meeting?.joinUrl ? (
          <div className="join">
            <a className="btn btn--primary btn--wide" href={meeting.joinUrl} target="_blank" rel="noreferrer">
              Join Zoom meeting
            </a>
            <div className="join__meta">
              <code className="join__url">{meeting.joinUrl}</code>
              <button type="button" className="btn btn--quiet" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <dl className="join__ids">
              <div>
                <dt>Meeting ID</dt>
                <dd>{meeting.meetingId}</dd>
              </div>
              {meeting.passcode ? (
                <div>
                  <dt>Passcode</dt>
                  <dd>{meeting.passcode}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        ) : null}

        {booking.warning ? (
          <div className="notice notice--warning" role="status">
            <div className="notice__body">
              <strong className="notice__title">{booking.warning.message}</strong>
              <div className="notice__text">
                Your booking is confirmed
                {meeting?.meetingId ? ` (meeting ${meeting.meetingId})` : ''}. Please don't book
                again — contact the host if you don't receive an invitation.
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <p className="hint">A calendar invitation is on its way to your email.</p>

      <div className="actions actions--center">
        <button type="button" className="btn btn--quiet" onClick={onBookAnother}>
          Book another meeting
        </button>
      </div>
    </div>
  );
}
