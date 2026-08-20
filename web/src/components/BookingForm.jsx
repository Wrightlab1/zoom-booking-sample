import { useState } from 'react';

import { formatFullDateTime } from '../time.js';

/**
 * Renders the host's own custom questions.
 *
 * `question` is sent back as the exact original string: the Zoom API matches
 * answers by question TEXT, case-sensitively, not by field id.
 */
function CustomField({ field, value, onChange }) {
  const id = `cf-${field.id ?? field.position}`;
  const common = {
    id,
    required: field.required,
    value,
    onChange: (e) => onChange(e.target.value),
  };

  return (
    <label className="field" htmlFor={id}>
      <span className="field__label">
        {field.question}
        {field.required ? <span className="field__req"> *</span> : null}
      </span>

      {field.format === 'choices_one' || field.format === 'select' ? (
        <select {...common}>
          <option value="">Choose…</option>
          {(field.choices ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      ) : field.format === 'text' ? (
        <textarea {...common} rows={3} />
      ) : (
        <input
          {...common}
          type={field.format === 'phone_number' ? 'tel' : 'text'}
        />
      )}
    </label>
  );
}

export default function BookingForm({
  host,
  slot,
  timeZone,
  values,
  onChange,
  onSubmit,
  onBack,
  submitting,
  notice,
}) {
  const [touched, setTouched] = useState(false);

  const customFields = host.customFields ?? [];
  const missingRequired = customFields
    .filter((f) => f.required)
    .some((f) => !String(values.answers[f.question] ?? '').trim());

  const incomplete =
    !values.firstName.trim() || !values.lastName.trim() || !values.email.trim() || missingRequired;

  const handleSubmit = (e) => {
    e.preventDefault();
    setTouched(true);
    if (incomplete) return;
    onSubmit();
  };

  return (
    <form className="stack" onSubmit={handleSubmit} noValidate>
      <header className="step-head">
        <p className="eyebrow">Step 3 of 3</p>
        <h2>Confirm your details</h2>
      </header>

      <div className="summary">
        <div>
          <span className="summary__label">With</span>
          <span className="summary__value">{host.host?.displayName || host.title}</span>
        </div>
        <div>
          <span className="summary__label">When</span>
          <span className="summary__value">{formatFullDateTime(slot.startTime, timeZone)}</span>
        </div>
        <div>
          <span className="summary__label">Length</span>
          <span className="summary__value">{slot.durationMinutes} minutes</span>
        </div>
      </div>

      {/* The slot-taken notice lives here, beside the form the user just filled in. */}
      {notice}

      <div className="grid-2">
        <label className="field" htmlFor="firstName">
          <span className="field__label">
            First name<span className="field__req"> *</span>
          </span>
          <input
            id="firstName"
            value={values.firstName}
            onChange={(e) => onChange({ firstName: e.target.value })}
            autoComplete="given-name"
          />
        </label>

        <label className="field" htmlFor="lastName">
          <span className="field__label">
            Last name<span className="field__req"> *</span>
          </span>
          <input
            id="lastName"
            value={values.lastName}
            onChange={(e) => onChange({ lastName: e.target.value })}
            autoComplete="family-name"
          />
        </label>
      </div>

      <label className="field" htmlFor="email">
        <span className="field__label">
          Email<span className="field__req"> *</span>
        </span>
        <input
          id="email"
          type="email"
          value={values.email}
          onChange={(e) => onChange({ email: e.target.value })}
          autoComplete="email"
        />
        <span className="field__hint">The meeting invitation goes here.</span>
      </label>

      {customFields.map((field) => (
        <CustomField
          key={field.id ?? field.position}
          field={field}
          value={values.answers[field.question] ?? ''}
          onChange={(v) =>
            onChange({ answers: { ...values.answers, [field.question]: v } })
          }
        />
      ))}

      {touched && incomplete ? (
        <p className="form-error" role="alert">
          Please complete the required fields.
        </p>
      ) : null}

      <div className="actions">
        <button type="button" className="btn btn--quiet" onClick={onBack} disabled={submitting}>
          ← Pick another time
        </button>
        <button type="submit" className="btn btn--primary" disabled={submitting}>
          {submitting ? 'Booking…' : 'Confirm booking'}
        </button>
      </div>
    </form>
  );
}
