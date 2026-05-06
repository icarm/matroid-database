import { Hono } from 'hono'

const app = new Hono()

app.get('/', (c) => c.text('Hello, world! — matroids.icarm.cloud'))

export default app
