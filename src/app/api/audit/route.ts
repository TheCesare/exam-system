import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const SETTINGS_ID = 'a0000000-a000-a000-a000-a00000000000'

// GET: return audit log (newest first, max 200)
export async function GET() {
  try {
    const { data, error } = await supabase
      .from('distribution_results')
      .select('data')
      .eq('id', SETTINGS_ID)
      .single()
    if (error || !data) return NextResponse.json([])
    const settings = data.data || {}
    const log: any[] = (settings.audit_log as any[]) || []
    // Return newest first, max 200
    return NextResponse.json(log.slice(-200).reverse())
  } catch {
    return NextResponse.json([], { status: 500 })
  }
}

// POST: add an audit entry (called internally)
export async function POST(request: NextRequest) {
  try {
    const { user, action, details } = await request.json()
    if (!user || !action) {
      return NextResponse.json({ error: 'User and action required' }, { status: 400 })
    }

    const { data } = await supabase
      .from('distribution_results')
      .select('data')
      .eq('id', SETTINGS_ID)
      .single()

    const settings = (data?.data as Record<string, any>) || {}
    const log: any[] = settings.audit_log || []
    log.push({
      id: 'aud_' + Date.now(),
      timestamp: new Date().toISOString(),
      user,
      action,
      details: details || ''
    })
    // Keep last 500 entries max
    if (log.length > 500) settings.audit_log = log.slice(-500)
    else settings.audit_log = log

    await supabase
      .from('distribution_results')
      .upsert({ id: SETTINGS_ID, data: settings }, { onConflict: 'id' })

    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}