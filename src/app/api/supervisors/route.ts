import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

const SETTINGS_ID = 'a0000000-a000-a000-a000-a00000000000'

async function getSettings(): Promise<Record<string, unknown>> {
  const { data, error } = await supabase
    .from('distribution_results')
    .select('data')
    .eq('id', SETTINGS_ID)
    .single()
  if (error || !data) return {}
  return data.data || {}
}

async function saveSettings(settings: Record<string, unknown>) {
  await supabase
    .from('distribution_results')
    .upsert({ id: SETTINGS_ID, data: settings }, { onConflict: 'id' })
}

// GET: return list of supervisors (names + permissions, no passwords)
export async function GET() {
  try {
    const settings = await getSettings()
      const allSupervisors: any[] = (settings.supervisors as any[]) || []
      // Never send passwords to client; include permissions
      return NextResponse.json(allSupervisors.map((s: any) => ({ id: s.id, name: s.name, permissions: s.permissions || [] })))
  } catch {
    return NextResponse.json([], { status: 500 })
  }
}

// POST: admin adds/edits a supervisor
export async function POST(request: NextRequest) {
  try {
    const { id, name, password, permissions } = await request.json()
    if (!name || !password) {
      return NextResponse.json({ error: 'Name and password required' }, { status: 400 })
    }

    const settings = await getSettings()
    const supervisors: { id: string; name: string; password: string; permissions?: string[] }[] = (settings.supervisors as any[]) || []

    if (id) {
      // Edit existing
      const idx = supervisors.findIndex(s => s.id === id)
      if (idx >= 0) {
        supervisors[idx].name = name
        if (password) supervisors[idx].password = password
        if (Array.isArray(permissions)) supervisors[idx].permissions = permissions
      }
    } else {
      // Add new
      const newId = 'sup_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
      supervisors.push({ id: newId, name, password, permissions: Array.isArray(permissions) ? permissions : [] })
    }

    settings.supervisors = supervisors
    await saveSettings(settings)
    return NextResponse.json({ success: true, supervisors: supervisors.map(s => ({ id: s.id, name: s.name, permissions: s.permissions || [] })) })
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}

// DELETE: admin removes a supervisor
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'ID required' }, { status: 400 })

    const settings = await getSettings()
    const supervisors: any[] = (settings.supervisors as any[]) || []
    settings.supervisors = supervisors.filter(s => s.id !== id)
    await saveSettings(settings)
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
