import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET() {
  try {
    const cells = await db.scheduleCell.findMany({ orderBy: [{ grade: 'asc' }, { day: 'asc' }] })
    return NextResponse.json(cells)
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    // body is array of { grade, day, committees, subject, time }
    if (!Array.isArray(body)) {
      return NextResponse.json({ error: 'Array expected' }, { status: 400 })
    }

    // Upsert each cell
    for (const cell of body) {
      await db.scheduleCell.upsert({
        where: { grade_day: { grade: cell.grade, day: cell.day } },
        update: {
          committees: cell.committees || 0,
          subject: cell.subject || '',
          time: cell.time || ''
        },
        create: {
          grade: cell.grade,
          day: cell.day,
          committees: cell.committees || 0,
          subject: cell.subject || '',
          time: cell.time || ''
        }
      })
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}