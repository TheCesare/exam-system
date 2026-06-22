import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function GET() {
  try {
    const { data, error } = await supabase
      .from('teachers')
      .select('*')
      .order('created_at', { ascending: true })
    if (error) throw error
    return NextResponse.json(data || [])
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
    const { data, error } = await supabase
      .from('teachers')
      .insert({ name, subject, notes: notes || '' })
      .select()
      .single()
    if (error) throw error
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Failed to create' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { id, name, subject, notes } = await request.json()
    if (!id) return NextResponse.json({ error: 'ID required' }, { status: 400 })
    const { data, error } = await supabase
      .from('teachers')
      .update({ name, subject, notes })
      .eq('id', id)
      .select()
      .single()
    if (error) throw error
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ error: 'Failed to update' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'ID required' }, { status: 400 })
    const { error } = await supabase.from('teachers').delete().eq('id', id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Failed to delete' }, { status: 500 })
  }
}