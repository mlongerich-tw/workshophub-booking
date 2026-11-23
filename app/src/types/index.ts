export interface TrainingSession {
  id: number
  title: string
  description: string
  date: string
  capacity: number
  registered: number
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
  createdAt: string
}

export interface SessionAvailability {
  id: number
  capacity: number
  registered: number
}

export interface RegistrationResponse {
  registration: Registration
  session: SessionAvailability
}

export interface ErrorResponse {
  error: string
}
