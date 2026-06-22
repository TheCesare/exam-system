import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// Bulk replace all teachers
export async function POST(request: NextRequest) {
  try {
    const { teachers } = await request.json()
    if (!Array.isArray(teachers)) {
      return NextResponse.json({ error: 'Array expected' }, { status: 400 })
    }
    // Delete all, insert new
    await supabase.from('teachers').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    const { error } = await supabase.from('teachers').insert(
      teachers.map((t: { name: string; subject: string; notes: string }) => ({
        name: t.name,
        subject: t.subject,
        notes: t.notes || ''
      }))
    )
    if (error) throw error
    return NextResponse.json({ success: true, count: teachers.length })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}

// Reset all data
export async function DELETE() {
  try {
    await supabase.from('teachers').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    await supabase.from('schedule_cells').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    await supabase.from('distribution_results').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}