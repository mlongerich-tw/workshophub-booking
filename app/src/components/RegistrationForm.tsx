import { useState } from 'react'
import type { FormEvent } from 'react'
import { loadStoredRegistration, saveStoredRegistration } from '../lib/registrationStorage'
import type {
  CancelRegistrationResponse,
  ConfirmedRegistrationResponse,
  ErrorResponse,
  SessionAvailability,
  StoredSessionRegistration,
  TrainingSession,
  WaitlistedRegistrationResponse,
} from '../types'

const API_BASE = import.meta.env.VITE_API_URL || ''

interface Props {
  session: TrainingSession
  onAvailabilityChange: (update: SessionAvailability) => void
}

interface Message {
  kind: 'success' | 'waitlisted' | 'error'
  text: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSessionAvailability(value: unknown): value is SessionAvailability {
  return (
    isRecord(value) &&
    typeof value.id === 'number' &&
    typeof value.capacity === 'number' &&
    typeof value.registered === 'number' &&
    typeof value.waitlisted === 'number'
  )
}

function hasRegistrationAndSession(value: Record<string, unknown>): boolean {
  return (
    isRecord(value.registration) &&
    typeof value.registration.id === 'number' &&
    isSessionAvailability(value.session)
  )
}

function isConfirmedResponse(value: unknown): value is ConfirmedRegistrationResponse {
  return isRecord(value) && value.status === 'confirmed' && hasRegistrationAndSession(value)
}

function isWaitlistedResponse(value: unknown): value is WaitlistedRegistrationResponse {
  return (
    isRecord(value) &&
    value.status === 'waitlisted' &&
    typeof value.position === 'number' &&
    hasRegistrationAndSession(value)
  )
}

function isCancelResponse(value: unknown): value is CancelRegistrationResponse {
  return isRecord(value) && value.status === 'cancelled' && isSessionAvailability(value.session)
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  return isRecord(value) && typeof value.error === 'string'
}

function RegistrationForm({ session, onAvailabilityChange }: Props) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [storedRegistration, setStoredRegistration] = useState<StoredSessionRegistration | null>(
    () => loadStoredRegistration(session.id)
  )
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const isFull = session.registered >= session.capacity

  function updateStoredRegistration(entry: StoredSessionRegistration) {
    setStoredRegistration(entry)
    saveStoredRegistration(session.id, entry)
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const res = await fetch(`${API_BASE}/api/training-sessions/${session.id}/registrations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email }),
      })
      const data: unknown = await res.json()

      if (res.status === 201 && isConfirmedResponse(data)) {
        onAvailabilityChange(data.session)
        updateStoredRegistration({
          registrationId: data.registration.id,
          status: 'confirmed',
        })
        setMessage({
          kind: 'success',
          text: `You're registered! Your registration ID is #${data.registration.id}.`,
        })
        setName('')
        setEmail('')
        setOpen(false)
      } else if (res.status === 202 && isWaitlistedResponse(data)) {
        onAvailabilityChange(data.session)
        setMessage({
          kind: 'waitlisted',
          text: `You're on the waitlist at position ${data.position}. Your place is not confirmed yet. Your registration ID is #${data.registration.id}.`,
        })
        setName('')
        setEmail('')
        setOpen(false)
      } else {
        setMessage({
          kind: 'error',
          text: isErrorResponse(data) ? data.error : `Registration failed (status ${res.status}).`,
        })
      }
    } catch {
      setMessage({ kind: 'error', text: 'Could not reach the server. Please try again.' })
    } finally {
      setSubmitting(false)
    }
  }

  async function handleConfirmCancel() {
    if (!storedRegistration || storedRegistration.status !== 'confirmed') return

    setCancelling(true)
    try {
      const res = await fetch(
        `${API_BASE}/api/training-sessions/${session.id}/registrations/${storedRegistration.registrationId}`,
        { method: 'DELETE' }
      )
      const data: unknown = await res.json()

      if (res.status === 200 && isCancelResponse(data)) {
        onAvailabilityChange(data.session)
        updateStoredRegistration({
          registrationId: storedRegistration.registrationId,
          status: 'cancelled',
        })
        setConfirmingCancel(false)
        setMessage({
          kind: 'success',
          text: 'Your registration has been cancelled',
        })
      } else if (res.status === 409) {
        updateStoredRegistration({
          registrationId: storedRegistration.registrationId,
          status: 'cancelled',
        })
        setConfirmingCancel(false)
        setMessage({
          kind: 'error',
          text: isErrorResponse(data) ? data.error : 'Registration is already cancelled',
        })
      } else {
        setMessage({
          kind: 'error',
          text: isErrorResponse(data) ? data.error : `Cancellation failed (status ${res.status}).`,
        })
      }
    } catch {
      setMessage({ kind: 'error', text: 'Could not reach the server. Please try again.' })
    } finally {
      setCancelling(false)
    }
  }

  const messageElement = (
    <p
      className={message ? `registration-message registration-message--${message.kind}` : ''}
      aria-live="polite"
    >
      {message?.text}
    </p>
  )

  if (!open) {
    return (
      <div className="session-card__actions">
        <div className="session-card__button-row">
          <button
            type="button"
            className="register-button"
            onClick={() => {
              setOpen(true)
              setConfirmingCancel(false)
              setMessage(null)
            }}
          >
            {isFull ? 'Join Waitlist' : 'Register'}
          </button>
          {storedRegistration?.status === 'confirmed' && !confirmingCancel && (
            <button
              type="button"
              className="cancel-button"
              onClick={() => {
                setConfirmingCancel(true)
                setMessage(null)
              }}
            >
              Cancel Registration
            </button>
          )}
          {storedRegistration?.status === 'cancelled' && (
            <button type="button" className="cancel-button" disabled aria-disabled="true">
              Cancelled
            </button>
          )}
        </div>
        {confirmingCancel && storedRegistration?.status === 'confirmed' && (
          <div className="cancel-confirm" role="alertdialog" aria-label="Confirm cancellation">
            <p className="cancel-confirm__prompt">
              Are you sure you want to cancel your registration for {session.title}?
            </p>
            <div className="cancel-confirm__actions">
              <button
                type="button"
                className="cancel-button cancel-button--confirm"
                onClick={handleConfirmCancel}
                disabled={cancelling}
              >
                {cancelling ? 'Cancelling…' : 'Yes, cancel registration'}
              </button>
              <button
                type="button"
                className="register-button register-button--secondary"
                onClick={() => setConfirmingCancel(false)}
                disabled={cancelling}
              >
                Keep registration
              </button>
            </div>
          </div>
        )}
        {messageElement}
      </div>
    )
  }

  return (
    <div className="session-card__actions">
      <form className="registration-form" onSubmit={handleSubmit}>
        <label className="registration-form__field">
          <span>Name</span>
          <input
            type="text"
            name="name"
            required
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="registration-form__field">
          <span>Email</span>
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <div className="registration-form__actions">
          <button type="submit" className="register-button" disabled={submitting}>
            {isFull
              ? submitting
                ? 'Joining…'
                : 'Join waitlist'
              : submitting
                ? 'Registering…'
                : 'Confirm registration'}
          </button>
          <button
            type="button"
            className="register-button register-button--secondary"
            onClick={() => setOpen(false)}
            disabled={submitting}
          >
            Cancel
          </button>
        </div>
      </form>
      {messageElement}
    </div>
  )
}

export default RegistrationForm
