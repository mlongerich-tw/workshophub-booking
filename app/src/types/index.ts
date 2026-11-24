export type RegistrationStatus = 'confirmed' | 'waitlisted' | 'cancelled'

export interface TrainingSession {
  id: number
  title: string
  description: string
  date: string
  capacity: number
  registered: number
  waitlisted: number
  location: string
  deliveryMode: string
  status: string
  createdAt: string
  updatedAt: string
}

export interface Registration {
  id: number
  sessionId: number
  name: string
  email: string
  status: RegistrationStatus
  createdAt: string
}

export interface SessionAvailability {
  id: number
  capacity: number
  registered: number
  waitlisted: number
}

export interface ConfirmedRegistrationResponse {
  status: 'confirmed'
  registration: Registration
  session: SessionAvailability
}

export interface WaitlistedRegistrationResponse {
  status: 'waitlisted'
  position: number
  registration: Registration
  session: SessionAvailability
}

export type RegistrationResponse = ConfirmedRegistrationResponse | WaitlistedRegistrationResponse

export interface CancelRegistrationResponse {
  status: 'cancelled'
  session: SessionAvailability
}

export interface StoredSessionRegistration {
  registrationId: number
  status: RegistrationStatus
}

export interface ErrorResponse {
  error: string
}
