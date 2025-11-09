import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'

type Env = {
  DB: D1Database
  ADMIN_TOKEN: string
}

const app = new Hono<{ Bindings: Env }>()
app.use('*', cors())

async function getOrCreateUser(c: Context<{ Bindings: Env }>, username: string) {
  const db = c.env.DB
  const u = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first<{ id: number }>()
  if (u) {
    // make sure balances row exists for legacy users
    await db.prepare('INSERT OR IGNORE INTO balances (user_id, points) VALUES (?, 0)').bind(u.id).run()
    return u.id
  }
  const res = await db.prepare('INSERT INTO users (username) VALUES (?)').bind(username).run()
  const id = res.lastInsertRowId as number
  await db.prepare('INSERT INTO balances (user_id, points) VALUES (?, 0)').bind(id).run()
  return id
}

function requireAdmin(c: Context<{ Bindings: Env }>) {
  const token = c.req.header('x-admin-token') || ''
  if (!token || token !== c.env.ADMIN_TOKEN) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  return null
}

app.post('/api/user/init', async (c: Context<{ Bindings: Env }>) => {
  const { username } = await c.req.json<{ username: string }>()
  if (!username) return c.json({ error: 'username_required' }, 400)
  const userId = await getOrCreateUser(c, username)
  const balance = await c.env.DB.prepare('SELECT points FROM balances WHERE user_id = ?').bind(userId).first<{ points: number }>()
  const events = await c.env.DB.prepare('SELECT id, title, points, created_at FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 100').bind(userId).all()
  const rewards = await c.env.DB.prepare('SELECT id, name, cost_points, stock, description FROM rewards WHERE enabled = 1 ORDER BY id DESC').all()
  return c.json({ userId, username, balance: balance?.points ?? 0, events: events.results, rewards: rewards.results })
})

app.post('/api/events', async (c: Context<{ Bindings: Env }>) => {
  const { username, title, points } = await c.req.json<{ username: string; title: string; points: number }>()
  if (!username || !title || typeof points !== 'number') return c.json({ error: 'invalid_payload' }, 400)
  const userId = await getOrCreateUser(c, username)
  await c.env.DB.prepare('INSERT INTO events (user_id, title, points) VALUES (?, ?, ?)').bind(userId, title, points).run()
  await c.env.DB.prepare('UPDATE balances SET points = points + ? WHERE user_id = ?').bind(points, userId).run()
  const balance = await c.env.DB.prepare('SELECT points FROM balances WHERE user_id = ?').bind(userId).first<{ points: number }>()
  return c.json({ ok: true, balance: balance?.points ?? 0 })
})

app.get('/api/overview', async (c: Context<{ Bindings: Env }>) => {
  const username = c.req.query('username')
  if (!username) return c.json({ error: 'username_required' }, 400)
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first<{ id: number }>()
  if (!user) return c.json({ balance: 0, events: [], rewards: [] })
  const balance = await c.env.DB.prepare('SELECT points FROM balances WHERE user_id = ?').bind(user.id).first<{ points: number }>()
  const events = await c.env.DB.prepare('SELECT id, title, points, created_at FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 100').bind(user.id).all()
  const rewards = await c.env.DB.prepare('SELECT id, name, cost_points, stock, description FROM rewards WHERE enabled = 1 ORDER BY id DESC').all()
  return c.json({ balance: balance?.points ?? 0, events: events.results, rewards: rewards.results })
})

app.post('/api/redeem', async (c: Context<{ Bindings: Env }>) => {
  const { username, reward_id } = await c.req.json<{ username: string; reward_id: number }>()
  if (!username || !reward_id) return c.json({ error: 'invalid_payload' }, 400)
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first<{ id: number }>()
  if (!user) return c.json({ error: 'user_not_found' }, 404)
  const reward = await c.env.DB.prepare('SELECT id, name, cost_points, stock, enabled FROM rewards WHERE id = ?').bind(reward_id).first<{ id: number; cost_points: number; stock: number | null; enabled: number }>()
  if (!reward || reward.enabled !== 1) return c.json({ error: 'reward_unavailable' }, 400)
  const bal = await c.env.DB.prepare('SELECT points FROM balances WHERE user_id = ?').bind(user.id).first<{ points: number }>()
  if ((bal?.points ?? 0) < reward.cost_points) return c.json({ error: 'insufficient_points' }, 400)
  if (reward.stock !== null && reward.stock <= 0) return c.json({ error: 'out_of_stock' }, 400)
  await c.env.DB.prepare('INSERT INTO redemptions (user_id, reward_id, cost_points, status) VALUES (?, ?, ?, "approved")').bind(user.id, reward.id, reward.cost_points).run()
  await c.env.DB.prepare('UPDATE balances SET points = points - ? WHERE user_id = ?').bind(reward.cost_points, user.id).run()
  if (reward.stock !== null) {
    await c.env.DB.prepare('UPDATE rewards SET stock = stock - 1 WHERE id = ?').bind(reward.id).run()
  }
  const balance = await c.env.DB.prepare('SELECT points FROM balances WHERE user_id = ?').bind(user.id).first<{ points: number }>()
  return c.json({ ok: true, balance: balance?.points ?? 0 })
})

app.post('/api/admin/rewards', async (c: Context<{ Bindings: Env }>) => {
  const unauth = requireAdmin(c)
  if (unauth) return unauth
  const body = await c.req.json<{ action: 'create'|'update'|'delete'; id?: number; name?: string; cost_points?: number; stock?: number|null; description?: string; enabled?: boolean }>()
  if (body.action === 'create') {
    const { name, cost_points, stock = null, description = '' } = body
    if (!name || typeof cost_points !== 'number') return c.json({ error: 'invalid_payload' }, 400)
    const res = await c.env.DB.prepare('INSERT INTO rewards (name, cost_points, stock, description, enabled) VALUES (?, ?, ?, ?, 1)').bind(name, cost_points, stock, description).run()
    return c.json({ ok: true, id: res.lastInsertRowId })
  }
  if (body.action === 'update') {
    const { id, name, cost_points, stock, description, enabled } = body
    if (!id) return c.json({ error: 'id_required' }, 400)
    await c.env.DB.prepare('UPDATE rewards SET name = COALESCE(?, name), cost_points = COALESCE(?, cost_points), stock = ?, description = COALESCE(?, description), enabled = COALESCE(?, enabled) WHERE id = ?')
      .bind(name ?? null, cost_points ?? null, stock ?? null, description ?? null, typeof enabled === 'boolean' ? (enabled ? 1 : 0) : null, id).run()
    return c.json({ ok: true })
  }
  if (body.action === 'delete') {
    if (!body.id) return c.json({ error: 'id_required' }, 400)
    await c.env.DB.prepare('DELETE FROM rewards WHERE id = ?').bind(body.id).run()
    return c.json({ ok: true })
  }
  return c.json({ error: 'unknown_action' }, 400)
})

app.post('/api/admin/points', async (c: Context<{ Bindings: Env }>) => {
  const unauth = requireAdmin(c)
  if (unauth) return unauth
  const { username, delta, reason } = await c.req.json<{ username: string; delta: number; reason?: string }>()
  if (!username || typeof delta !== 'number') return c.json({ error: 'invalid_payload' }, 400)
  const userId = await getOrCreateUser(c, username)
  if (delta !== 0) {
    if (reason) {
      await c.env.DB.prepare('INSERT INTO events (user_id, title, points) VALUES (?, ?, ?)').bind(userId, reason, delta).run()
    }
    await c.env.DB.prepare('UPDATE balances SET points = points + ? WHERE user_id = ?').bind(delta, userId).run()
  }
  const balance = await c.env.DB.prepare('SELECT points FROM balances WHERE user_id = ?').bind(userId).first<{ points: number }>()
  return c.json({ ok: true, balance: balance?.points ?? 0 })
})

app.delete('/api/admin/events/:id', async (c: Context<{ Bindings: Env }>) => {
  const unauth = requireAdmin(c)
  if (unauth) return unauth
  const id = Number(c.req.param('id'))
  const ev = await c.env.DB.prepare('SELECT user_id, points FROM events WHERE id = ?').bind(id).first<{ user_id: number; points: number }>()
  if (!ev) return c.json({ error: 'not_found' }, 404)
  await c.env.DB.prepare('DELETE FROM events WHERE id = ?').bind(id).run()
  await c.env.DB.prepare('UPDATE balances SET points = points - ? WHERE user_id = ?').bind(ev.points, ev.user_id).run()
  return c.json({ ok: true })
})

app.get('/api/admin/rewards', async (c: Context<{ Bindings: Env }>) => {
  const unauth = requireAdmin(c)
  if (unauth) return unauth
  const rewards = await c.env.DB.prepare('SELECT id, name, cost_points, stock, description, enabled FROM rewards ORDER BY id DESC').all()
  return c.json({ rewards: rewards.results })
})

// List users with their current points
app.get('/api/admin/users', async (c: Context<{ Bindings: Env }>) => {
  const unauth = requireAdmin(c)
  if (unauth) return unauth
  const users = await c.env.DB
    .prepare('SELECT u.id, u.username, COALESCE(b.points, 0) AS points, u.created_at FROM users u LEFT JOIN balances b ON b.user_id = u.id ORDER BY u.id DESC LIMIT 1000')
    .all()
  return c.json({ users: users.results })
})

export default app
