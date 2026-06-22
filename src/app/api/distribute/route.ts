import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// Bulk replace all teachers (for import/demo)
export async function POST(request: NextRequest) {
  try {
    const { teachers } = await request.json()
    if (!Array.isArray(teachers)) {
      return NextResponse.json({ error: 'Array expected' }, { status: 400 })
    }
    await db.teacher.deleteMany()
    const created = await db.teacher.createMany({
      data: teachers.map((t: { name: string; subject: string; notes: string }) => ({
        name: t.name,
        subject: t.subject,
        notes: t.notes || ''
      }))
    })
    return NextResponse.json({ success: true, count: created.count })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}

// Reset all data
export async function DELETE() {
  try {
    await db.teacher.deleteMany()
    await db.scheduleCell.deleteMany()
    await db.distributionResult.deleteMany()
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}