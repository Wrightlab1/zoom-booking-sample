import { formatDayLabel, formatTime, isSameInstant, weekDates } from '../time.js';

/**
 * A week at a time: one column per day, bookable times listed beneath.
 *
 * `deadSlot` is the slot that was just lost to someone else. It stays visible
 * for one render, struck through and labelled, so the user can see WHY the grid
 * changed under them rather than watching a time silently vanish.
 */
export default function SlotGrid({
  weekStart,
  slots,
  timeZone,
  onSelect,
  onPrevWeek,
  onNextWeek,
  canGoBack,
  loading,
  deadSlot,
}) {
  const days = weekDates(weekStart);
  const byDate = new Map(days.map((d) => [d, []]));
  for (const slot of slots) {
    if (byDate.has(slot.date)) byDate.get(slot.date).push(slot);
  }

  const total = slots.length;

  return (
    <div className="stack">
      <div className="week-nav">
        <button
          type="button"
          className="btn btn--quiet"
          onClick={onPrevWeek}
          disabled={!canGoBack || loading}
        >
          ← Previous
        </button>
        <p className="week-nav__range">
          {formatDayLabel(days[0], timeZone).month} {formatDayLabel(days[0], timeZone).day} –{' '}
          {formatDayLabel(days[6], timeZone).month} {formatDayLabel(days[6], timeZone).day}
        </p>
        <button type="button" className="btn btn--quiet" onClick={onNextWeek} disabled={loading}>
          Next →
        </button>
      </div>

      <div className={`week${loading ? ' week--loading' : ''}`} aria-busy={loading}>
        {days.map((date) => {
          const label = formatDayLabel(date, timeZone);
          const daySlots = byDate.get(date) ?? [];
          const showDead = deadSlot && deadSlot.date === date;

          return (
            <div key={date} className="day">
              <div className="day__head">
                <span className="day__weekday">{label.weekday}</span>
                <span className="day__date">{label.day}</span>
              </div>

              <div className="day__slots">
                {showDead ? (
                  <span className="slot slot--dead" aria-label="No longer available">
                    {formatTime(deadSlot.startTime, timeZone)}
                  </span>
                ) : null}

                {daySlots.map((slot) => (
                  <button
                    key={slot.startTime}
                    type="button"
                    className="slot"
                    onClick={() => onSelect(slot)}
                    disabled={loading}
                  >
                    {formatTime(slot.startTime, timeZone)}
                  </button>
                ))}

                {daySlots.length === 0 && !showDead ? (
                  <span className="day__empty" aria-hidden="true">
                    –
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <p className="hint">
        {total === 0
          ? 'Nothing free this week. Try the next one.'
          : `${total} time${total === 1 ? '' : 's'} available · shown in ${timeZone}`}
      </p>
    </div>
  );
}

export { isSameInstant };
