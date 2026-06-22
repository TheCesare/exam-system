import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET() {
  try {
    const result = await db.distributionResult.findFirst({ orderBy: { createdAt: 'desc' } })
    if (!result) return NextResponse.json(null)
    return NextResponse.json({ id: result.id, data: JSON.parse(result.data), createdAt: result.createdAt })
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const { data } = await request.json()
    // Delete old results, save new one
    await db.distributionResult.deleteMany()
    const result = await db.distributionResult.create({
      data: { data: JSON.stringify(data) }
    })
    return NextResponse.json({ success: true, id: result.id })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}