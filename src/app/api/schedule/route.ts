import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function GET() {
  try {
    const { data, error } = await supabase
      .from('schedule_cells')
      .select('*')
      .order('grade', { ascending: true })
      .order('day', { ascending: true })
    if (error) throw error
    return NextResponse.json(data || [])
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    if (!Array.isArray(body)) {
      return NextResponse.json({ error: 'Array expected' }, { status: 400 })
    }

    // Delete all existing, then insert new
    await supabase.from('schedule_cells').delete().neq('id', '00000000-0000-0000-0000-000000000000')

    if (body.length > 0) {
      const { error } = await supabase.from('schedule_cells').insert(
        body.map((cell: { grade: string; day: string; committees: number; subject: string; time: string }) => ({
          grade: cell.grade,
          day: cell.day,
          committees: cell.committees || 0,
          subject: cell.subject || '',
          time: cell.time || ''
        }))
      )
      if (error) throw error
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}