import type { RegistrationStatus, StoredSessionRegistration } from '../types'

const STORAGE_KEY = 'workshophub.registrations'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRegistrationStatus(value: unknown): value is RegistrationStatus {
  return value === 'confirmed' || value === 'waitlisted' || value === 'cancelled'
}

function isStoredSessionRegistration(value: unknown): value is StoredSessionRegistration {
  return (
    isRecord(value) &&
    typeof value.registrationId === 'number' &&
    Number.isInteger(value.registrationId) &&
    value.registrationId > 0 &&
    isRegistrationStatus(value.status)
  )
}

function readAll(): Record<string, StoredSessionRegistration> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return {}

    const entries: Record<string, StoredSessionRegistration> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (isStoredSessionRegistration(value)) {
        entries[key] = value
      }
    }
    return entries
  } catch {
    return {}
  }
}

export function loadStoredRegistration(sessionId: number): StoredSessionRegistration | null {
  const all = readAll()
  return all[String(sessionId)] ?? null
}

export function saveStoredRegistration(sessionId: number, entry: StoredSessionRegistration): void {
  try {
    const all = readAll()
    all[String(sessionId)] = entry
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Ignore storage write errors (e.g. private browsing quota restrictions)
  }
}
