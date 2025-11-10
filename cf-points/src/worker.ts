import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'

type Env = {
  DB: D1Database
  ADMIN_TOKEN: string
  ADMIN_USER?: string
  ADMIN_PASS?: string
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

function getCookie(c: Context, name: string): string | null {
  const cookie = c.req.header('cookie') || ''
  for (const part of cookie.split(';')) {
    const [k, v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v || '')
  }
  return null
}

function requireAdmin(c: Context<{ Bindings: Env }>) {
  const token = c.req.header('x-admin-token') || ''
  const cookieToken = getCookie(c as any, 'admin_token') || ''
  if (token === c.env.ADMIN_TOKEN || cookieToken === c.env.ADMIN_TOKEN) {
    return null
  }
  if (!token && !cookieToken) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  return c.json({ error: 'unauthorized' }, 401)
}

app.post('/api/user/init', async (c: Context<{ Bindings: Env }>) => {
  const { username } = await c.req.json<{ username: string }>()
  if (!username) return c.json({ error: 'username_required' }, 400)
  const userId = await getOrCreateUser(c, username)
  const balance = await c.env.DB.prepare('SELECT points FROM balances WHERE user_id = ?').bind(userId).first<{ points: number }>()
  const sumRow = await c.env.DB.prepare('SELECT COALESCE(SUM(points), 0) AS s FROM events WHERE user_id = ?').bind(userId).first<{ s: number }>()
  const rsumRow = await c.env.DB.prepare('SELECT COALESCE(SUM(cost_points), 0) AS r FROM redemptions WHERE user_id = ? AND status = "approved"').bind(userId).first<{ r: number }>()
  const pointsNow = balance?.points ?? 0
  const sumPoints = sumRow?.s ?? 0
  const redeemed = rsumRow?.r ?? 0
  const effective = sumPoints - redeemed
  if (pointsNow !== effective) {
    await c.env.DB.prepare('INSERT OR IGNORE INTO balances (user_id, points) VALUES (?, 0)').bind(userId).run()
    await c.env.DB.prepare('UPDATE balances SET points = ? WHERE user_id = ?').bind(effective, userId).run()
  }
  const events = await c.env.DB.prepare('SELECT id, title, points, created_at FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 100').bind(userId).all()
  const rewards = await c.env.DB.prepare('SELECT id, name, cost_points, stock, description FROM rewards WHERE enabled = 1 ORDER BY id DESC').all()
  return c.json({ userId, username, balance: effective, events: events.results, rewards: rewards.results })
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
  const sumRow = await c.env.DB.prepare('SELECT COALESCE(SUM(points), 0) AS s FROM events WHERE user_id = ?').bind(user.id).first<{ s: number }>()
  const rsumRow = await c.env.DB.prepare('SELECT COALESCE(SUM(cost_points), 0) AS r FROM redemptions WHERE user_id = ? AND status = "approved"').bind(user.id).first<{ r: number }>()
  const pointsNow = balance?.points ?? 0
  const sumPoints = sumRow?.s ?? 0
  const redeemed = rsumRow?.r ?? 0
  const effective = sumPoints - redeemed
  if (pointsNow !== effective) {
    await c.env.DB.prepare('INSERT OR IGNORE INTO balances (user_id, points) VALUES (?, 0)').bind(user.id).run()
    await c.env.DB.prepare('UPDATE balances SET points = ? WHERE user_id = ?').bind(effective, user.id).run()
  }
  const events = await c.env.DB.prepare('SELECT id, title, points, created_at FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 100').bind(user.id).all()
  const rewards = await c.env.DB.prepare('SELECT id, name, cost_points, stock, description FROM rewards WHERE enabled = 1 ORDER BY id DESC').all()
  return c.json({ balance: effective, events: events.results, rewards: rewards.results })
})

async function handleRedeem(c: Context<{ Bindings: Env }>, username: string, rewardId: number) {
  if (!username || !rewardId) return c.json({ error: 'invalid_payload' }, 400)
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first<{ id: number }>()
  if (!user) return c.json({ error: 'user_not_found' }, 404)
  const reward = await c.env.DB.prepare('SELECT id, name, cost_points, stock, enabled FROM rewards WHERE id = ?').bind(rewardId).first<{ id: number; cost_points: number; stock: number | null; enabled: number }>()
  if (!reward || reward.enabled !== 1) return c.json({ error: 'reward_unavailable' }, 400)
  // self-heal: reconcile balances from events minus approved redemptions
  const sumRow = await c.env.DB.prepare('SELECT COALESCE(SUM(points), 0) AS s FROM events WHERE user_id = ?').bind(user.id).first<{ s: number }>()
  const rsumRow = await c.env.DB.prepare('SELECT COALESCE(SUM(cost_points), 0) AS r FROM redemptions WHERE user_id = ? AND status = "approved"').bind(user.id).first<{ r: number }>()
  const balRow = await c.env.DB.prepare('SELECT points FROM balances WHERE user_id = ?').bind(user.id).first<{ points: number }>()
  const sumPoints = sumRow?.s ?? 0
  const redeemed = rsumRow?.r ?? 0
  const shouldBe = sumPoints - redeemed
  const balPoints = balRow?.points ?? 0
  if (balPoints !== shouldBe) {
    await c.env.DB.prepare('INSERT OR IGNORE INTO balances (user_id, points) VALUES (?, 0)').bind(user.id).run()
    await c.env.DB.prepare('UPDATE balances SET points = ? WHERE user_id = ?').bind(shouldBe, user.id).run()
  }
  const bal = await c.env.DB.prepare('SELECT points FROM balances WHERE user_id = ?').bind(user.id).first<{ points: number }>()
  if ((bal?.points ?? 0) < reward.cost_points) return c.json({ error: 'insufficient_points', balance: bal?.points ?? 0, need: reward.cost_points }, 400)
  if (reward.stock !== null && reward.stock <= 0) return c.json({ error: 'out_of_stock' }, 400)
  // race-safe conditional updates
  if (reward.stock !== null) {
    const dec = await c.env.DB
      .prepare('UPDATE rewards SET stock = stock - 1 WHERE id = ? AND stock > 0')
      .bind(reward.id)
      .run()
    if (!dec || (dec as any).meta && (dec as any).meta.changes === 0) {
      return c.json({ error: 'out_of_stock' }, 400)
    }
  }

  const decBal = await c.env.DB
    .prepare('UPDATE balances SET points = points - ? WHERE user_id = ? AND points >= ?')
    .bind(reward.cost_points, user.id, reward.cost_points)
    .run()
  if (!decBal || (decBal as any).meta && (decBal as any).meta.changes === 0) {
    // rollback stock if we deducted it
    if (reward.stock !== null) {
      await c.env.DB.prepare('UPDATE rewards SET stock = stock + 1 WHERE id = ?').bind(reward.id).run()
    }
    return c.json({ error: 'insufficient_points' }, 400)
  }

  await c.env.DB
    .prepare('INSERT INTO redemptions (user_id, reward_id, cost_points, status) VALUES (?, ?, ?, "approved")')
    .bind(user.id, reward.id, reward.cost_points)
    .run()
  // log redemption as a 0-point event so it shows in history
  await c.env.DB
    .prepare('INSERT INTO events (user_id, title, points) VALUES (?, ?, 0)')
    .bind(user.id, `兑换：${reward.name}`)
    .run()
  const balance = await c.env.DB.prepare('SELECT points FROM balances WHERE user_id = ?').bind(user.id).first<{ points: number }>()
  return c.json({ ok: true, balance: balance?.points ?? 0 })
}

app.post('/api/redeem', async (c: Context<{ Bindings: Env }>) => {
  const body = await c.req.json<{ username: string; reward_id: number }>().catch(() => ({ username: '', reward_id: 0 }))
  const { username, reward_id } = body
  return handleRedeem(c, username, Number(reward_id))
})

// GET fallback: /api/redeem?username=xxx&reward_id=123
app.get('/api/redeem', async (c: Context<{ Bindings: Env }>) => {
  const username = c.req.query('username') || ''
  const reward_id = Number(c.req.query('reward_id') || '0')
  return handleRedeem(c, username, reward_id)
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

// Rewards list with pagination & search
app.get('/api/admin/rewards', async (c: Context<{ Bindings: Env }>) => {
  const unauth = requireAdmin(c)
  if (unauth) return unauth
  const page = Math.max(1, Number(c.req.query('page') || '1'))
  const size = Math.min(100, Math.max(1, Number(c.req.query('size') || '20')))
  const keyword = (c.req.query('keyword') || '').trim()
  let where = ''
  let binds: any[] = []
  if (keyword) { where = 'WHERE name LIKE ? OR description LIKE ?'; binds.push(`%${keyword}%`, `%${keyword}%`) }
  const totalRow = await c.env.DB.prepare(`SELECT COUNT(1) AS n FROM rewards ${where}`).bind(...binds).first<{ n: number }>()
  binds.push(size, (page - 1) * size)
  const rows = await c.env.DB.prepare(`SELECT id, name, cost_points, stock, description, enabled FROM rewards ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).bind(...binds).all()
  return c.json({ items: rows.results, total: totalRow?.n ?? 0, page, size, rewards: rows.results })
})

// List users with their current points
app.get('/api/admin/users', async (c: Context<{ Bindings: Env }>) => {
  const unauth = requireAdmin(c)
  if (unauth) return unauth
  const page = Math.max(1, Number(c.req.query('page') || '1'))
  const size = Math.min(100, Math.max(1, Number(c.req.query('size') || '20')))
  const keyword = (c.req.query('keyword') || '').trim()
  let where = ''
  let binds: any[] = []
  if (keyword) { where = 'WHERE u.username LIKE ?'; binds.push(`%${keyword}%`) }
  const totalRow = await c.env.DB.prepare(`SELECT COUNT(1) AS n FROM users u ${where}`).bind(...binds).first<{ n: number }>()
  binds.push(size, (page - 1) * size)
  const users = await c.env.DB
    .prepare(`SELECT u.id, u.username, COALESCE(b.points, 0) AS points, u.created_at FROM users u LEFT JOIN balances b ON b.user_id = u.id ${where} ORDER BY u.id DESC LIMIT ? OFFSET ?`)
    .bind(...binds)
    .all()
  return c.json({ items: users.results, total: totalRow?.n ?? 0, page, size, users: users.results })
})

// CSV export endpoints
app.get('/api/admin/export/:kind', async (c: Context<{ Bindings: Env }>) => {
  const unauth = requireAdmin(c)
  if (unauth) return unauth
  const kind = c.req.param('kind')
  let header = ''
  let rows: any[] = []
  if (kind === 'users') {
    header = 'id,username,points,created_at\n'
    const r = await c.env.DB
      .prepare('SELECT u.id, u.username, COALESCE(b.points,0) AS points, u.created_at FROM users u LEFT JOIN balances b ON b.user_id=u.id ORDER BY u.id DESC')
      .all()
    rows = r.results as any[]
  } else if (kind === 'rewards') {
    header = 'id,name,cost_points,stock,enabled,description\n'
    const r = await c.env.DB.prepare('SELECT id,name,cost_points,stock,enabled,description FROM rewards ORDER BY id DESC').all()
    rows = r.results as any[]
  } else if (kind === 'events') {
    header = 'id,user_id,title,points,created_at\n'
    const r = await c.env.DB.prepare('SELECT id,user_id,title,points,created_at FROM events ORDER BY id DESC LIMIT 5000').all()
    rows = r.results as any[]
  } else {
    return c.json({ error: 'unknown_kind' }, 400)
  }
  const csv = header + rows.map((o) => Object.values(o).map(v => String(v).replaceAll('"','""')).map(v => /[,"]/.test(v) ? `"${v}"` : v).join(',')).join('\n')
  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Cache-Control', 'no-store')
  return c.body(csv)
})

export default app
