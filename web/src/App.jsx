import { useCallback, useEffect, useState } from 'react';

import { ApiError, createBooking, getHost, listHosts, listSlots } from './api.js';
import { addDays, browserTimeZone, isSameInstant, startOfDay } from './time.js';
import BookingForm from './components/BookingForm.jsx';
import Confirmation from './components/Confirmation.jsx';
import ErrorNotice from './components/ErrorNotice.jsx';
import HostPicker from './components/HostPicker.jsx';
import SlotGrid from './components/SlotGrid.jsx';

const EMPTY_FORM = { firstName: '', lastName: '', email: '', answers: {} };

export default function App() {
  const [stage, setStage] = useState('hosts'); // hosts → slots → form → done
  const [hosts, setHosts] = useState([]);
  const [host, setHost] = useState(null);
  const [slots, setSlots] = useState([]);
  const [slot, setSlot] = useState(null);
  const [booking, setBooking] = useState(null);

  const [weekStart, setWeekStart] = useState(() => startOfDay(new Date()));
  const [loading, setLoading] = useState(true);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [hint, setHint] = useState(null);

  // The form survives a lost slot, so it lives above the form component.
  const [form, setForm] = useState(EMPTY_FORM);
  // The slot someone else took, kept for one grid render so the change is visible.
  const [deadSlot, setDeadSlot] = useState(null);

  const timeZone = browserTimeZone;

  // ── Step 1 ──────────────────────────────────────────────────────────────
  const loadHosts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { hosts: list, hint: serverHint } = await listHosts();
      setHosts(list);
      setHint(list.length === 0 ? serverHint ?? 'No hosts are available yet.' : null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHosts();
  }, [loadHosts]);

  // ── Step 2 ──────────────────────────────────────────────────────────────
  const fetchSlots = useCallback(
    async (targetHost, start) => {
      setSlotsLoading(true);
      try {
        const from = new Date(Math.max(start.getTime(), Date.now())).toISOString();
        const to = addDays(startOfDay(start), 7).toISOString();
        const data = await listSlots(targetHost.slug, { from, to, timeZone });
        setSlots(data.slots ?? []);
        return data.slots ?? [];
      } catch (err) {
        setError(err);
        setSlots([]);
        return [];
      } finally {
        setSlotsLoading(false);
      }
    },
    [timeZone]
  );

  const chooseHost = async (picked) => {
    setError(null);
    setLoading(true);
    try {
      // Fetch detail so the form can render this host's own questions.
      const { host: full } = await getHost(picked.slug);
      const start = startOfDay(new Date());
      setHost(full);
      setWeekStart(start);
      setStage('slots');
      setDeadSlot(null);
      await fetchSlots(full, start);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  };

  const changeWeek = async (delta) => {
    const next = addDays(weekStart, delta * 7);
    setWeekStart(next);
    setDeadSlot(null);
    await fetchSlots(host, next);
  };

  const chooseSlot = (picked) => {
    setSlot(picked);
    setDeadSlot(null);
    setError(null);
    setStage('form');
  };

  // ── Step 3 ──────────────────────────────────────────────────────────────
  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { booking: made } = await createBooking({
        scheduleSlug: host.slug,
        startDateTime: slot.startTime, // verbatim — never re-serialised
        durationMinutes: slot.durationMinutes ?? host.durationMinutes,
        timeZone,
        booker: {
          email: form.email.trim(),
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
        },
        answers: Object.entries(form.answers)
          .filter(([, v]) => String(v).trim())
          .map(([question, answer]) => ({ question, answer })),
      });
      setBooking(made);
      setStage('done');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SLOT_TAKEN') {
        // Someone booked it first. This is a normal outcome of a system with no
        // hold API — recover in place: keep every field the user typed, refresh
        // the grid, and explain the change beside the form. No alert, no reset.
        setDeadSlot(slot);
        setSlot(null);
        setStage('slots');
        setError(err);
        await fetchSlots(host, weekStart);
      } else {
        setError(err);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setStage('hosts');
    setHost(null);
    setSlot(null);
    setSlots([]);
    setBooking(null);
    setForm(EMPTY_FORM);
    setDeadSlot(null);
    setError(null);
    loadHosts();
  };

  const back = () => {
    setStage(stage === 'form' ? 'slots' : 'hosts');
    setError(null);
  };

  // ── Rendering ───────────────────────────────────────────────────────────
  const slotTakenNotice =
    error instanceof ApiError && error.code === 'SLOT_TAKEN' ? (
      <ErrorNotice tone="warning" title="That time was just booked">
        Someone else took it while you were filling in the form. Your details are saved —
        just pick another time below.
      </ErrorNotice>
    ) : null;

  const hardError =
    error && !(error instanceof ApiError && error.code === 'SLOT_TAKEN') ? (
      <ErrorNotice
        tone="error"
        title={error.message}
        onRetry={stage === 'hosts' ? loadHosts : () => fetchSlots(host, weekStart)}
      >
        {error.detail ? <code className="notice__detail">{error.detail}</code> : null}
      </ErrorNotice>
    ) : null;

  return (
    <div className="page">
      <header className="masthead">
        <h1>Book a meeting</h1>
        <p className="masthead__sub">Pick a host, choose a time, get a Zoom link.</p>
      </header>

      <main className="card">
        {hardError}

        {stage === 'hosts' ? (
          loading ? (
            <p className="hint">Loading hosts…</p>
          ) : hosts.length ? (
            <HostPicker hosts={hosts} onSelect={chooseHost} />
          ) : (
            <ErrorNotice tone="warning" title="No hosts available" onRetry={loadHosts}>
              {hint}
            </ErrorNotice>
          )
        ) : null}

        {stage === 'slots' && host ? (
          <div className="stack">
            <header className="step-head">
              <p className="eyebrow">Step 2 of 3</p>
              <h2>When suits you?</h2>
              <p className="step-head__sub">
                {host.durationMinutes} minutes with {host.host?.displayName || host.title}
              </p>
            </header>

            {slotTakenNotice}

            <SlotGrid
              weekStart={weekStart}
              slots={slots}
              timeZone={timeZone}
              deadSlot={deadSlot}
              loading={slotsLoading}
              onSelect={chooseSlot}
              onPrevWeek={() => changeWeek(-1)}
              onNextWeek={() => changeWeek(1)}
              canGoBack={weekStart > startOfDay(new Date())}
            />

            <div className="actions">
              <button type="button" className="btn btn--quiet" onClick={back}>
                ← Choose someone else
              </button>
            </div>
          </div>
        ) : null}

        {stage === 'form' && host && slot ? (
          <BookingForm
            host={host}
            slot={slot}
            timeZone={timeZone}
            values={form}
            onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
            onSubmit={submit}
            onBack={back}
            submitting={submitting}
            notice={null}
          />
        ) : null}

        {stage === 'done' && booking ? (
          <Confirmation booking={booking} timeZone={timeZone} onBookAnother={reset} />
        ) : null}
      </main>

      <footer className="footnote">
        Times shown in {timeZone}. Availability comes from Zoom Scheduler.
      </footer>
    </div>
  );
}

export { isSameInstant };
