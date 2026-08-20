/**
 * Inline, never a modal or an alert.
 *
 * `tone` separates "you need to do something" (warning) from "this is broken"
 * (error). A slot being taken is a warning: expected, recoverable, and not the
 * user's fault.
 */
export default function ErrorNotice({ tone = 'error', title, children, onRetry, retryLabel = 'Try again' }) {
  return (
    <div className={`notice notice--${tone}`} role="status">
      <div className="notice__body">
        {title ? <strong className="notice__title">{title}</strong> : null}
        {children ? <div className="notice__text">{children}</div> : null}
      </div>
      {onRetry ? (
        <button type="button" className="btn btn--quiet" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
