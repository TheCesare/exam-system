import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const SETTINGS_ID = 'a0000000-a000-a000-a000-a00000000000'

export async function GET() {
  try {
    const { data, error } = await supabase
      .from('distribution_results')
      .select('data')
      .eq('id', SETTINGS_ID)
      .single()
    if (error && error.code !== 'PGRST116') throw error
    if (!data) return NextResponse.json({ user_can_edit_teachers: false })
    return NextResponse.json(data.data || { user_can_edit_teachers: false })
  } catch {
    return NextResponse.json({ user_can_edit_teachers: false })
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json()
    const { error } = await supabase
      .from('distribution_results')
      .upsert({ id: SETTINGS_ID, data: body }, { onConflict: 'id' })
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}