import { Router, IRouter, Request, Response } from 'express'
import { registerForSession, validateRegistrationInput } from '../services/registrationService'

const router: IRouter = Router({ mergeParams: true })

router.post('/', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const sessionId = parseInt(req.params.id, 10)
    if (isNaN(sessionId)) {
      res.status(400).json({ error: 'Invalid session ID' })
      return
    }

    const parsed = validateRegistrationInput(req.body)
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error })
      return
    }

    const result = await registerForSession(sessionId, parsed.value)

    switch (result.kind) {
      case 'not_found':
        res.status(404).json({ error: 'Training session not found' })
        return
      case 'full':
        res.status(409).json({ error: 'Training session is full' })
        return
      case 'created': {
        const { id, name, email, createdAt } = result.registration
        res.status(201).json({
          registration: { id, sessionId: result.registration.sessionId, name, email, createdAt },
          session: result.session,
        })
        return
      }
      default: {
        const unreachable: never = result
        throw new Error(`Unhandled registration result: ${JSON.stringify(unreachable)}`)
      }
    }
  } catch (error) {
    console.error('Error creating registration:', error)
    res.status(500).json({ error: 'Failed to create registration' })
  }
})

export default router
