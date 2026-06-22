import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET() {
  try {
    const teachers = await db.teacher.findMany({ orderBy: { createdAt: 'asc' } })
    return NextResponse.json(teachers)
  } catch {
    return NextResponse.json({ error: 'Failed to fetch' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const { name, subject, notes } = await request.json()
    if (!name || !subject) {
      return NextResponse.json({ error: 'Name and subject required' }, { status: 400 })
    }
    const teacher = await db.teacher.create({
      data: { name, subject, notes: notes || '' }
    })
    return NextResponse.json(teacher)
  } catch {
    return NextResponse.json({ error: 'Failed to create' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { id, name, subject, notes } = await request.json()
    if (!id) return NextResponse.json({ error: 'ID required' }, { status: 400 })
    const teacher = await db.teacher.update({
      where: { id },
      data: { name, subject, notes }
    })
    return NextResponse.json(teacher)
  } catch {
    return NextResponse.json({ error: 'Failed to update' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'ID required' }, { status: 400 })
    await db.teacher.delete({ where: { id } })
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Failed to delete' }, { status: 500 })
  }
}