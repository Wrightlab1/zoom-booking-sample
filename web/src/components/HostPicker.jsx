export default function HostPicker({ hosts, onSelect }) {
  return (
    <div className="stack">
      <header className="step-head">
        <p className="eyebrow">Step 1 of 3</p>
        <h2>Who would you like to meet?</h2>
      </header>

      <ul className="host-list">
        {hosts.map((host) => (
          <li key={host.slug}>
            <button type="button" className="host-card" onClick={() => onSelect(host)}>
              <span className="host-card__main">
                <span className="host-card__name">{host.host?.displayName || host.title}</span>
                <span className="host-card__title">{host.title}</span>
                {host.description ? (
                  <span className="host-card__desc">{host.description}</span>
                ) : null}
              </span>
              <span className="host-card__meta">
                <span className="pill">{host.durationMinutes} min</span>
                {host.timeZone ? <span className="host-card__tz">{host.timeZone}</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
