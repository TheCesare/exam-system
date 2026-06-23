import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function GET() {
  try {
    const { data, error } = await supabase
      .from('distribution_results')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    if (error && error.code !== 'PGRST116') throw error // PGRST116 = no rows
    if (!data) return NextResponse.json(null)
    return NextResponse.json({ id: data.id, data: data.data, createdAt: data.created_at })
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const { data } = await request.json()
    // Delete old results (keep settings rows)
    await supabase.from('distribution_results').delete()
      .neq('id', '00000000-0000-0000-0000-000000000000')
      .neq('id', 'a0000000-a000-a000-a000-a00000000000')
    // Save new
    const { error } = await supabase.from('distribution_results').insert({ data })
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e) {
    console.error(e)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}