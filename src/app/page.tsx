'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createClient, RealtimeChannel } from '@supabase/supabase-js';

// ========== CONSTANTS ==========
const DAYS = ['Saturday','Sunday','Monday','Tuesday','Wednesday','Thursday'];
const GRADES = [
  'Grade 3 Primary','Grade 4 Primary','Grade 5 Primary','Grade 6 Primary',
  'Grade 1 Prep','Grade 2 Prep','Grade 1 Secondary','Grade 2 Secondary'
];
const SUBJECTS = ['Math','Science','Arabic','English','French','Social Studies',
                  'Arts','Computer','Library','Religion','Psychology','Admin','Other'];
const DEFAULT_TIMES: Record<string,string> = {
  'Grade 3 Primary':'9:00-10:30','Grade 4 Primary':'9:00-10:30',
  'Grade 5 Primary':'9:00-10:30','Grade 6 Primary':'9:00-10:30',
  'Grade 1 Prep':'9:00-11:00','Grade 2 Prep':'9:00-11:00',
  'Grade 1 Secondary':'12:00-14:00','Grade 2 Secondary':'8:30-10:30'
};

// ========== TYPES ==========
interface Teacher { id: string; name: string; subject: string; notes: string; }
interface ScheduleCell { id?: string; grade: string; day: string; committees: number; subject: string; time: string; }
interface TrackingEntry { totalComm: number; totalHours: number; dayComm: Record<string,number>; assignedSlots: {day:string;start:number;end:number}[]; }
interface CommitteeResult { serial: number; t1: {id:string|null;name:string}; t2: {id:string|null;name:string}; }
interface SessionResult { grade: string; time: string; subject: string; committees: CommitteeResult[]; }

type View = 'login' | 'user' | 'admin';
type Page = 'teachers' | 'schedule' | 'distribute' | 'results' | 'stats';

// ========== HELPERS ==========
function parseTimeRange(tStr: string) {
  if (!tStr || !tStr.includes('-')) return { start: 540, end: 630, duration: 1.5 };
  try {
    let clean = tStr.replace(/\s+/g, '').replace(/—/g, '-').replace(/–/g, '-');
    const parts = clean.split('-');
    const toMinutes = (s: string) => { const p = s.split(':'); return (parseInt(p[0])||0)*60 + (parseInt(p[1])||0); };
    let start = toMinutes(parts[0]);
    let end = toMinutes(parts[1]);
    if (end <= start) end += 720;
    return { start, end, duration: (end - start) / 60 };
  } catch { return { start: 540, end: 630, duration: 1.5 }; }
}

function getStage(grade: string) {
  const g = grade.toLowerCase();
  if (g.includes('primary')) return 'primary';
  if (g.includes('prep')) return 'prep';
  if (g.includes('secondary') || g.includes('sec')) return 'sec';
  return 'any';
}

// ========== TOAST ==========
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string, type: 'success' | 'error' | 'info' = 'info') {
  const el = document.getElementById('app-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show ' + type;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3000);
}

// ========== MAIN COMPONENT ==========
export default function ExamSystem() {
  // Auth state
  const [view, setView] = useState<View>('login');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isConnected, setIsConnected] = useState(true); // Assume connected until proven otherwise

  // Data state
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [schedule, setSchedule] = useState<ScheduleCell[]>([]);
  const [results, setResults] = useState<{ assignments: Record<string, SessionResult[]>; tracking: Record<string, TrackingEntry> } | null>(null);

  // UI state
  const [activePage, setActivePage] = useState<Page>('teachers');
  const [showAddTeacher, setShowAddTeacher] = useState(false);
  const [editTeacherId, setEditTeacherId] = useState<string | null>(null);
  const [formName, setFormName] = useState('');
  const [formSubject, setFormSubject] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [loading, setLoading] = useState(true);

  // Schedule edit buffer (local edits before saving)
  const [scheduleBuffer, setScheduleBuffer] = useState<Record<string, ScheduleCell>>({});

  // Ref for Supabase realtime channels
  const channelsRef = useRef<RealtimeChannel[]>([]);

  // ========== LOAD DATA ==========
  const loadTeachers = useCallback(async () => {
    try {
      const res = await fetch('/api/teachers');
      if (res.ok) setTeachers(await res.json());
    } catch { /* silent */ }
  }, []);

  const loadSchedule = useCallback(async () => {
    try {
      const res = await fetch('/api/schedule');
      if (res.ok) {
        const data: ScheduleCell[] = await res.json();
        setSchedule(data);
        // Build buffer
        const buf: Record<string, ScheduleCell> = {};
        data.forEach(c => { buf[`${c.grade}__${c.day}`] = c; });
        setScheduleBuffer(buf);
      }
    } catch { /* silent */ }
  }, []);

  const loadResults = useCallback(async () => {
    try {
      const res = await fetch('/api/results');
      if (res.ok) {
        const data = await res.json();
        if (data && data.data) setResults(data.data);
      }
    } catch { /* silent */ }
  }, []);

  const loadAll = useCallback(() => {
    setLoading(true);
    Promise.all([loadTeachers(), loadSchedule(), loadResults()])
      .finally(() => setLoading(false));
  }, [loadTeachers, loadSchedule, loadResults]);

  // ========== SUPABASE REALTIME ==========
  useEffect(() => {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) return;

    const sb = createClient(supabaseUrl, supabaseKey);

    // Subscribe to teachers changes
    const teachersCh = sb.channel('teachers-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teachers' }, () => {
        loadTeachers();
      })
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED');
      });

    // Subscribe to schedule changes
    const scheduleCh = sb.channel('schedule-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schedule_cells' }, () => {
        loadSchedule();
      })
      .subscribe();

    // Subscribe to results changes
    const resultsCh = sb.channel('results-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'distribution_results' }, () => {
        loadResults();
      })
      .subscribe();

    channelsRef.current = [teachersCh, scheduleCh, resultsCh];

    return () => {
      teachersCh.unsubscribe();
      scheduleCh.unsubscribe();
      resultsCh.unsubscribe();
    };
  }, [loadTeachers, loadSchedule, loadResults]);

  // ========== AUTH ==========
  const handleLogin = async (role: 'user' | 'admin') => {
    if (role === 'user') {
      setView('user');
      loadAll();
      return;
    }
    // Admin login
    if (!password.trim()) { setLoginError('ادخل كلمة السر'); return; }
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await res.json();
      if (data.success) {
        setView('admin');
        loadAll();
      } else {
        setLoginError(data.message || 'كلمة السر غلط');
      }
    } catch { setLoginError('خطأ في الاتصال'); }
  };

  const handleLogout = () => {
    setView('login');
    setPassword('');
    setLoginError('');
    setTeachers([]);
    setSchedule([]);
    setResults(null);
  };

  // ========== TEACHER ACTIONS ==========
  const saveTeacher = async () => {
    if (!formName.trim() || !formSubject) { showToast('Fill all required fields', 'error'); return; }
    try {
      if (editTeacherId) {
        await fetch('/api/teachers', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: editTeacherId, name: formName.trim(), subject: formSubject, notes: formNotes.trim() })
        });
        showToast('تم تعديل المعلم', 'success');
      } else {
        await fetch('/api/teachers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: formName.trim(), subject: formSubject, notes: formNotes.trim() })
        });
        showToast('تم إضافة المعلم', 'success');
      }
      cancelEdit();
      loadTeachers();
    } catch { showToast('Error saving teacher', 'error'); }
  };

  const deleteTeacher = async (id: string) => {
    if (!confirm('Delete this teacher?')) return;
    try {
      await fetch(`/api/teachers?id=${id}`, { method: 'DELETE' });
      loadTeachers();
      showToast('تم حذف المعلم', 'success');
    } catch { showToast('Error deleting', 'error'); }
  };

  const startEdit = (t: Teacher) => {
    setEditTeacherId(t.id);
    setFormName(t.name);
    setFormSubject(t.subject);
    setFormNotes(t.notes);
    setShowAddTeacher(true);
  };

  const cancelEdit = () => {
    setEditTeacherId(null);
    setFormName('');
    setFormSubject('');
    setFormNotes('');
    setShowAddTeacher(false);
  };

  const generateDemoTeachers = async () => {
    const demoTeachers: { name: string; subject: string; notes: string }[] = [];
    let count = 1;
    for (let i = 1; i <= 15; i++) {
      demoTeachers.push({ name: `Math Specialist Expert T${count++}`, subject: 'Math', notes: i <= 9 ? 'prep, sec' : '' });
    }
    for (let i = 1; i <= 45; i++) demoTeachers.push({ name: `English Senior Faculty T${count++}`, subject: 'English', notes: '' });
    for (let i = 1; i <= 40; i++) demoTeachers.push({ name: `Arabic Lang Professor T${count++}`, subject: 'Arabic', notes: i <= 16 ? 'prep, sec' : '' });
    for (let i = 1; i <= 9; i++) demoTeachers.push({ name: `French Educator Staff T${count++}`, subject: 'French', notes: '' });
    for (let i = 1; i <= 8; i++) demoTeachers.push({ name: `Social Studies Instructor T${count++}`, subject: 'Social Studies', notes: i === 1 ? 'prep, sec' : '' });
    for (let i = 1; i <= 9; i++) demoTeachers.push({ name: `Pure Science Research T${count++}`, subject: 'Science', notes: '' });
    const otherSubs = ['Arts', 'Computer', 'Library', 'Religion', 'Psychology', 'Admin', 'Other'];
    for (let i = 1; i <= 74; i++) {
      demoTeachers.push({ name: `${otherSubs[i % otherSubs.length]} Resource Officer T${count++}`, subject: otherSubs[i % otherSubs.length], notes: '' });
    }
    try {
      await fetch('/api/distribute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teachers: demoTeachers }) });
      loadTeachers();
      showToast('Added 200 teachers!', 'success');
    } catch { showToast('Error', 'error'); }
  };

  const importCSV = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.csv';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const text = await file.text();
      const lines = text.split('\n');
      const imported: { name: string; subject: string; notes: string }[] = [];
      lines.forEach(line => {
        const parts = line.split(',').map(p => p.trim());
        if (parts.length >= 2 && parts[0]) imported.push({ name: parts[0], subject: parts[1], notes: parts[2] || '' });
      });
      if (imported.length === 0) { showToast('No valid data in CSV', 'error'); return; }
      try {
        await fetch('/api/distribute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ teachers: imported }) });
        loadTeachers();
        showToast(`Imported ${imported.length} teachers`, 'success');
      } catch { showToast('Import error', 'error'); }
    };
    input.click();
  };

  // ========== SCHEDULE ACTIONS ==========
  const updateCell = (grade: string, day: string, field: 'committees' | 'subject' | 'time', value: string | number) => {
    const key = `${grade}__${day}`;
    setScheduleBuffer(prev => ({
      ...prev,
      [key]: { ...prev[key], grade, day, [field]: value, id: prev[key]?.id }
    }));
  };

  const saveSchedule = async () => {
    const cells = Object.values(scheduleBuffer);
    try {
      await fetch('/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cells) });
      showToast('Schedule saved!', 'success');
      loadSchedule();
    } catch { showToast('Error saving schedule', 'error'); }
  };

  const resetSchedule = async () => {
    if (!confirm('Reset schedule?')) return;
    setScheduleBuffer({});
    try {
      await fetch('/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([]) });
      loadSchedule();
      showToast('Schedule reset', 'info');
    } catch { /* silent */ }
  };

  // ========== DISTRIBUTION ENGINE ==========
  const runDistribution = () => {
    if (teachers.length === 0) { showToast('No teachers in registry!', 'error'); return; }

    // Get rule checkboxes
    const ruleSubject = (document.getElementById('rule-subject') as HTMLInputElement)?.checked ?? true;
    const ruleDayLimit = (document.getElementById('rule-daylimit') as HTMLInputElement)?.checked ?? true;
    const ruleNotes = (document.getElementById('rule-notes') as HTMLInputElement)?.checked ?? true;

    const tracking: Record<string, TrackingEntry> = {};
    teachers.forEach(t => {
      tracking[t.id] = { totalComm: 0, totalHours: 0, dayComm: {} as Record<string,number>, assignedSlots: [] };
      DAYS.forEach(d => { tracking[t.id].dayComm[d] = 0; });
    });

    // Build all slots
    const allSlots: { day: string; grade: string; stage: string; subject: string; time: string; timeInfo: ReturnType<typeof parseTimeRange>; comId: number }[] = [];
    DAYS.forEach(day => {
      GRADES.forEach(grade => {
        const cell = scheduleBuffer[`${grade}__${day}`];
        if (cell && cell.committees > 0) {
          const timeInfo = parseTimeRange(cell.time || DEFAULT_TIMES[grade] || '9:00-10:30');
          for (let c = 1; c <= cell.committees; c++) {
            allSlots.push({ day, grade, stage: getStage(grade), subject: cell.subject || '', time: cell.time || DEFAULT_TIMES[grade] || '9:00-10:30', timeInfo, comId: c });
          }
        }
      });
    });

    allSlots.sort((a, b) => b.timeInfo.duration - a.timeInfo.duration);

    // Build final assignments
    const finalAssignments: Record<string, SessionResult[]> = {};
    DAYS.forEach(d => { finalAssignments[d] = []; });
    DAYS.forEach(day => {
      GRADES.forEach(grade => {
        const cell = scheduleBuffer[`${grade}__${day}`];
        if (cell && cell.committees > 0) {
          const existing = finalAssignments[day].find(s => s.grade === grade && s.time === (cell.time || DEFAULT_TIMES[grade]));
          if (!existing) {
            finalAssignments[day].push({ grade, time: cell.time || DEFAULT_TIMES[grade] || '', subject: cell.subject || '', committees: [] });
          }
        }
      });
    });

    const findTeacher = (blockedId: string | null, slot: typeof allSlots[0], relaxDay: boolean = false): Teacher | null => {
      let pool: { teacher: Teacher; matchScore: number; totalComm: number; totalHours: number }[] = [];
      teachers.forEach(t => {
        if (blockedId && t.id === blockedId) return;
        const tr = tracking[t.id];
        if (ruleSubject && slot.subject && t.subject === slot.subject) return;
        const hasOverlap = tr.assignedSlots.some(s => s.day === slot.day && !(slot.timeInfo.end <= s.start || slot.timeInfo.start >= s.end));
        if (hasOverlap) return;
        if (!relaxDay && ruleDayLimit && tr.dayComm[slot.day] >= 1) return;
        let todayHours = 0;
        const seen = new Set<string>();
        tr.assignedSlots.filter(s => s.day === slot.day).forEach(s => {
          const k = s.start + '_' + s.end;
          if (!seen.has(k)) { seen.add(k); todayHours += (s.end - s.start) / 60; }
        });
        if (todayHours + slot.timeInfo.duration > 5) return;
        let matchScore = 0;
        if (ruleNotes && t.notes && slot.stage !== 'any' && t.notes.toLowerCase().includes(slot.stage)) matchScore = 1;
        pool.push({ teacher: t, matchScore, totalComm: tr.totalComm, totalHours: tr.totalHours });
      });
      if (pool.length === 0) return null;
      pool.sort((a, b) => {
        if (a.totalComm !== b.totalComm) return a.totalComm - b.totalComm;
        if (Math.abs(a.totalHours - b.totalHours) > 0.001) return a.totalHours - b.totalHours;
        if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
        return a.teacher.id.localeCompare(b.teacher.id);
      });
      return pool[0].teacher;
    };

    allSlots.forEach(slot => {
      const t1 = findTeacher(null, slot, false) || findTeacher(null, slot, true);
      if (t1) {
        tracking[t1.id].totalComm++;
        tracking[t1.id].dayComm[slot.day]++;
        tracking[t1.id].totalHours += slot.timeInfo.duration;
        tracking[t1.id].assignedSlots.push({ day: slot.day, start: slot.timeInfo.start, end: slot.timeInfo.end });
      }
      const t2 = findTeacher(t1?.id || null, slot, false) || findTeacher(t1?.id || null, slot, true);
      if (t2) {
        tracking[t2.id].totalComm++;
        tracking[t2.id].dayComm[slot.day]++;
        tracking[t2.id].totalHours += slot.timeInfo.duration;
        tracking[t2.id].assignedSlots.push({ day: slot.day, start: slot.timeInfo.start, end: slot.timeInfo.end });
      }

      const dayGroup = finalAssignments[slot.day];
      const sessionGroup = dayGroup.find(s => s.grade === slot.grade && s.time === slot.time);
      if (sessionGroup) {
        sessionGroup.committees.push({
          serial: slot.comId,
          t1: t1 ? { id: t1.id, name: t1.name } : { id: null, name: 'Standby Monitor' },
          t2: t2 ? { id: t2.id, name: t2.name } : { id: null, name: 'Standby Monitor' }
        });
      }
    });

    const newResults = { assignments: finalAssignments, tracking };
    setResults(newResults);

    // Save to server
    fetch('/api/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: newResults }) });
    showToast('Distribution complete!', 'success');
    setActivePage('results');
  };

  // ========== EXPORT CSV ==========
  const exportCSV = () => {
    if (!results?.assignments) return;
    let csv = 'Day,Grade,Time,Subject,Committee,Supervisor1,Supervisor2\n';
    DAYS.forEach(day => {
      const sessions = results.assignments[day] || [];
      sessions.forEach(s => {
        s.committees.forEach(c => {
          csv += `"${day}","${s.grade}","${s.time}","${s.subject || ''}","Room ${c.serial}","${c.t1.name}","${c.t2.name}"\n`;
        });
      });
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'exam_schedule.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  // ========== RESET ALL ==========
  const resetAll = async () => {
    if (!confirm('Reset ALL data?')) return;
    await fetch('/api/distribute', { method: 'DELETE' });
    loadAll();
    setResults(null);
  };

  // ========== RENDER HELPERS ==========
  const getCell = (grade: string, day: string): ScheduleCell => {
    return scheduleBuffer[`${grade}__${day}`] || { grade, day, committees: 0, subject: '', time: DEFAULT_TIMES[grade] || '9:00-10:30' };
  };

  const totalCommittees = Object.values(scheduleBuffer).reduce((a, c) => a + (c.committees || 0), 0);
  const totalSlots = totalCommittees * 2;

  // ========== LOGIN SCREEN ==========
  if (view === 'login') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', zIndex: 1 }}>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 48, maxWidth: 440, width: '90%', textAlign: 'center' }}>
          <div style={{ width: 12, height: 12, background: 'var(--accent)', borderRadius: '50%', margin: '0 auto 16px', animation: 'pulse 2s infinite' }} />
          <h1 style={{ fontFamily: 'var(--mono)', fontSize: 16, color: 'var(--accent)', letterSpacing: 2, marginBottom: 8 }}>EXAM · SUPERVISOR</h1>
          <p style={{ color: 'var(--text2)', fontSize: 13, marginBottom: 32 }}>نظام توزيع لجان الإشراف على الامتحانات</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <button
              onClick={() => handleLogin('user')}
              style={{ padding: '14px 24px', borderRadius: 10, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--sans)', transition: 'all 0.2s' }}
              onMouseOver={e => { (e.target as HTMLElement).style.borderColor = 'var(--accent)'; }}
              onMouseOut={e => { (e.target as HTMLElement).style.borderColor = 'var(--border)'; }}
            >
              👤 دخول كمستخدم
            </button>
            <div style={{ color: 'var(--text2)', fontSize: 11, margin: '4px 0' }}>────── أو ──────</div>

            <input
              type="password"
              placeholder="كلمة سر الأدمن"
              value={password}
              onChange={e => { setPassword(e.target.value); setLoginError(''); }}
              onKeyDown={e => e.key === 'Enter' && handleLogin('admin')}
              style={{ padding: '12px 16px', borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 14, fontFamily: 'var(--sans)', outline: 'none', textAlign: 'center' }}
            />
            {loginError && <p style={{ color: 'var(--danger)', fontSize: 12, margin: '-4px 0 0' }}>{loginError}</p>}
            <button
              onClick={() => handleLogin('admin')}
              style={{ padding: '14px 24px', borderRadius: 10, background: 'var(--accent2)', border: 'none', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--sans)', transition: 'all 0.2s' }}
              onMouseOver={e => { (e.target as HTMLElement).style.background = '#e55a2b'; }}
              onMouseOut={e => { (e.target as HTMLElement).style.background = 'var(--accent2)'; }}
            >
              🔐 دخول كأدمن
            </button>
          </div>

          <div style={{ marginTop: 24, fontSize: 11, color: 'var(--text2)' }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: isConnected ? 'var(--success)' : 'var(--danger)', marginRight: 6 }} />
            {isConnected ? 'متصل بالسيرفر' : 'غير متصل'}
          </div>
        </div>
      </div>
    );
  }

  const isAdmin = view === 'admin';
  const roleLabel = isAdmin ? 'ADMIN' : 'USER';
  const roleColor = isAdmin ? 'var(--accent2)' : 'var(--accent3)';

  // ========== TEACHERS PAGE ==========
  const renderTeachersPage = () => (
    <div className="card">
      <div className="card-header">
        <div className="card-title">سجل المعلمين</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {isAdmin && (
            <>
              <button className="btn btn-demo" onClick={generateDemoTeachers}>🧪 Generate 200 Mock</button>
              <button className="btn btn-ghost" onClick={importCSV}>📂 Import CSV</button>
            </>
          )}
          <button className="btn btn-primary" onClick={() => { if (isAdmin) { cancelEdit(); setShowAddTeacher(!showAddTeacher); } else { cancelEdit(); setShowAddTeacher(!showAddTeacher); } }}>
            + أضف معلم
          </button>
        </div>
      </div>

      {showAddTeacher && (
        <div style={{ background: 'var(--surface2)', borderRadius: 10, padding: 20, marginBottom: 20 }}>
          <div className="grid-3">
            <div className="form-group">
              <label className="form-label">الاسم الكامل</label>
              <input className="form-input" value={formName} onChange={e => setFormName(e.target.value)} placeholder="e.g. Ahmed Ali" />
            </div>
            <div className="form-group">
              <label className="form-label">المادة التخصصية</label>
              <select className="form-select" value={formSubject} onChange={e => setFormSubject(e.target.value)}>
                <option value="">-- اختر المادة --</option>
                {SUBJECTS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">ملاحظات المرحلة</label>
              <input className="form-input" value={formNotes} onChange={e => setFormNotes(e.target.value)} placeholder="e.g. prep, sec, primary" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" onClick={saveTeacher}>✓ حفظ</button>
            <button className="btn btn-ghost" onClick={cancelEdit}>إلغاء</button>
          </div>
        </div>
      )}

      <div id="teachers-stats" style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <span className="badge badge-green">الإجمالي: {teachers.length}</span>
        {Object.entries(teachers.reduce((acc: Record<string,number>, t) => { acc[t.subject] = (acc[t.subject]||0)+1; return acc; }, {})).map(([s,c]) => (
          <span key={s} className="badge badge-blue">{s}: {c}</span>
        ))}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th><th>اسم المعلم</th><th>المادة</th><th>ملاحظات المرحلة</th>
              {isAdmin && <th>إجراءات</th>}
            </tr>
          </thead>
          <tbody>
            {teachers.length === 0 ? (
              <tr><td colSpan={isAdmin ? 5 : 4} style={{ textAlign: 'center', padding: 32 }}>لا يوجد معلمين</td></tr>
            ) : teachers.map((t, i) => (
              <tr key={t.id}>
                <td>{i + 1}</td>
                <td style={{ fontWeight: 600, color: '#fff' }}>{t.name}</td>
                <td><span className="badge badge-blue">{t.subject}</span></td>
                <td style={{ color: 'var(--accent3)' }}>{t.notes || 'Any Stage'}</td>
                {isAdmin && (
                  <td>
                    <button className="action-btn edit-btn" onClick={() => startEdit(t)}>✏️</button>
                    <button className="action-btn del-btn" onClick={() => deleteTeacher(t.id)}>✕</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  // ========== SCHEDULE PAGE ==========
  const renderSchedulePage = () => (
    <div className="card">
      <div className="card-header">
        <div className="card-title">خريطة الجدول الامتحاني</div>
        <button className="btn btn-primary" onClick={saveSchedule}>💾 حفظ الجدول</button>
      </div>
      <div className="table-wrap" style={{ maxHeight: '70vh', overflow: 'auto' }}>
        <div className="schedule-grid">
          <div className="sg-header">المرحلة</div>
          {DAYS.map(d => <div key={d} className="sg-header">{d}</div>)}

          {GRADES.map(grade => (
            <React.Fragment key={grade}>
              <div className="sg-grade">{grade}</div>
              {DAYS.map(day => {
                const cell = getCell(grade, day);
                return (
                  <div key={day} className="sg-cell">
                    <input type="number" min="0" placeholder="لجان" value={cell.committees || ''} onChange={e => updateCell(grade, day, 'committees', parseInt(e.target.value) || 0)} />
                    <select value={cell.subject || ''} onChange={e => updateCell(grade, day, 'subject', e.target.value)}>
                      <option value="">المادة</option>
                      {SUBJECTS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <input type="text" placeholder="التوقيت" value={cell.time || ''} onChange={e => updateCell(grade, day, 'time', e.target.value)} />
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );

  // ========== DISTRIBUTE PAGE (Admin Only) ==========
  const renderDistributePage = () => (
    <>
      <div className="grid-4" style={{ marginBottom: 24 }}>
        <div className="stat-card"><span className="stat-number">{teachers.length}</span><div className="stat-label">المعلمين المتاحين</div></div>
        <div className="stat-card"><span className="stat-number">{totalCommittees}</span><div className="stat-label">اللجان الفعالة</div></div>
        <div className="stat-card"><span className="stat-number">{totalSlots}</span><div className="stat-label">إجمالي المهام</div></div>
      </div>
      <div className="card">
        <div className="card-title" style={{ marginBottom: 16 }}>قيود محرك التوزيع</div>
        <div className="grid-2">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" id="rule-subject" defaultChecked style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
              منع الإشراف على مادة التخصص
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" id="rule-daylimit" defaultChecked style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
              حد أقصى لجنة واحدة في اليوم
            </label>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" id="rule-notes" defaultChecked style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
              مطابقة تفضيلات المرحلة
            </label>
          </div>
        </div>
      </div>
      <div style={{ textAlign: 'center', padding: 32 }}>
        <button className="btn btn-orange" onClick={runDistribution}>
          ⚡ تشغيل محرك التوزيع
        </button>
      </div>
    </>
  );

  // ========== RESULTS PAGE ==========
  const renderResultsPage = () => {
    if (!results?.assignments) return <div className="card"><div style={{ textAlign: 'center', padding: 48, color: 'var(--text2)' }}>شغّل محرك التوزيع لعرض النتائج</div></div>;

    return (
      <div>
        {DAYS.map(day => {
          const sessions = results.assignments[day] || [];
          if (sessions.length === 0) return null;
          return (
            <div key={day} className="result-day">
              <div className="result-day-header" onClick={() => {
                const body = document.getElementById('day-body-' + day);
                if (body) body.style.display = body.style.display === 'none' ? 'block' : 'none';
              }}>
                <div className="result-day-title">📅 اليوم: {day}</div>
                <span>عرض ▼</span>
              </div>
              <div className="result-day-body" id={'day-body-' + day} style={{ display: 'block' }}>
                {sessions.map((session, si) => (
                  <div key={si} className="result-session">
                    <div className="result-session-header">
                      <span className="rs-grade">{session.grade}</span>
                      <span className="rs-time">⏰ {session.time}</span>
                      <span className="rs-subject">📖 {session.subject || 'غير محدد'}</span>
                    </div>
                    <div className="result-com" style={{ background: 'var(--surface2)', fontSize: 12, fontWeight: 600 }}>
                      <div className="rc-cell rc-num">اللجنة</div>
                      <div className="rc-cell">المشرف الأول</div>
                      <div className="rc-cell">المشرف الثاني</div>
                      <div className="rc-cell" style={{ justifyContent: 'center' }}>العبء اليومي</div>
                    </div>
                    {session.committees.map((c, ci) => {
                      const dc1 = c.t1.id ? results.tracking[c.t1.id]?.dayComm[day] : 0;
                      const dc2 = c.t2.id ? results.tracking[c.t2.id]?.dayComm[day] : 0;
                      return (
                        <div key={ci} className="result-com">
                          <div className="rc-cell rc-num">لجنة {c.serial}</div>
                          <div className="rc-cell">{c.t1.name}</div>
                          <div className="rc-cell">{c.t2.name}</div>
                          <div className="rc-cell" style={{ justifyContent: 'center', fontFamily: 'var(--mono)', color: 'var(--text2)', fontSize: 11 }}>
                            {c.t1.id ? dc1 + ' duty' : '-'} / {c.t2.id ? dc2 + ' duty' : '-'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // ========== STATS PAGE (Admin Only) ==========
  const renderStatsPage = () => {
    if (!results?.tracking || teachers.length === 0) return <div className="card"><div style={{ textAlign: 'center', padding: 48, color: 'var(--text2)' }}>لا توجد بيانات</div></div>;

    const tr = results.tracking;
    // Fix double counting
    teachers.forEach(t => {
      if (!tr[t.id]) return;
      const slots = tr[t.id].assignedSlots || [];
      const seen = new Set<string>();
      let uniqueHours = 0;
      slots.forEach(s => {
        const key = s.day + '_' + s.start + '_' + s.end;
        if (!seen.has(key)) { seen.add(key); uniqueHours += (s.end - s.start) / 60; }
      });
      tr[t.id].totalHours = uniqueHours;
    });

    let totalComAll = 0, totalHrsAll = 0, over5Count = 0, notUsedCount = 0;
    teachers.forEach(t => {
      const tt = tr[t.id] || { totalComm: 0, totalHours: 0 };
      totalComAll += tt.totalComm || 0;
      totalHrsAll += tt.totalHours || 0;
      if ((tt.totalHours || 0) > 5) over5Count++;
      if ((tt.totalComm || 0) === 0) notUsedCount++;
    });
    const maxHrs = Math.max(...teachers.map(t => tr[t.id]?.totalHours || 0));
    const sorted = [...teachers].sort((a, b) => (tr[b.id]?.totalHours || 0) - (tr[a.id]?.totalHours || 0));

    return (
      <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 20 }}>
          <div className="stat-card"><span className="stat-number">{totalHrsAll.toFixed(1)}</span><div className="stat-label">إجمالي الساعات</div></div>
          <div className="stat-card"><span className="stat-number">{(totalHrsAll / Math.max(teachers.length, 1)).toFixed(1)}</span><div className="stat-label">متوسط / معلم</div></div>
          <div className="stat-card"><span className="stat-number">{maxHrs.toFixed(1)}</span><div className="stat-label">أعلى ساعات</div></div>
          <div className="stat-card"><span className="stat-number" style={{ color: 'var(--danger)' }}>{over5Count}</span><div className="stat-label">أكثر من 5 ساعات</div></div>
          <div className="stat-card"><span className="stat-number" style={{ color: 'var(--warning)' }}>{notUsedCount}</span><div className="stat-label">لم يتم تعيينه</div></div>
        </div>
        <div className="card">
          <div className="card-title" style={{ marginBottom: 16 }}>ملخص ساعات المعلمين</div>
          <div className="table-wrap" style={{ maxHeight: '70vh', overflow: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>#</th><th>الاسم</th><th>المادة</th>
                  {DAYS.map(d => <th key={d}>{d.slice(0, 3)}</th>)}
                  <th style={{ background: 'rgba(0,212,255,0.1)' }}>اللجان<br/>الإجمالي</th>
                  <th style={{ background: 'rgba(0,255,157,0.1)' }}>الساعات<br/>الإجمالي</th>
                  <th>الحالة</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((t, i) => {
                  const tt = tr[t.id] || { totalComm: 0, totalHours: 0, dayComm: {} };
                  const hrs = tt.totalHours || 0;
                  const pct = maxHrs > 0 ? Math.round(hrs / maxHrs * 100) : 0;
                  const hrsColor = hrs > 5 ? 'var(--danger)' : hrs > 3 ? 'var(--accent3)' : hrs > 0 ? 'var(--accent)' : 'var(--text2)';
                  const status = hrs === 0 ? <span className="badge" style={{ background: 'rgba(255,68,68,0.1)', color: 'var(--danger)' }}>غير مستخدم</span>
                    : hrs > 5 ? <span className="badge" style={{ background: 'rgba(255,68,68,0.1)', color: 'var(--danger)' }}>⚠️ أكثر من 5س</span>
                    : <span className="badge" style={{ background: 'rgba(0,255,157,0.1)', color: 'var(--accent3)' }}>✓ OK</span>;
                  return (
                    <tr key={t.id}>
                      <td style={{ color: 'var(--text2)' }}>{i + 1}</td>
                      <td style={{ fontWeight: 600, color: '#fff' }}>{t.name}</td>
                      <td><span className="badge badge-blue">{t.subject}</span></td>
                      {DAYS.map(d => {
                        const val = tt.dayComm[d] || 0;
                        return <td key={d} style={{ textAlign: 'center', fontWeight: 600, color: val >= 2 ? 'var(--accent2)' : val === 1 ? 'var(--accent3)' : 'var(--text2)' }}>{val || '-'}</td>;
                      })}
                      <td style={{ textAlign: 'center', fontWeight: 700, color: 'var(--accent)', fontFamily: 'var(--mono)' }}>{tt.totalComm}</td>
                      <td style={{ background: 'rgba(0,255,157,0.03)', padding: '8px 14px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: hrsColor, minWidth: 48 }}>{hrs.toFixed(1)}h</span>
                          <div style={{ flex: 1, height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: hrsColor, borderRadius: 3, transition: 'width 0.3s' }} />
                          </div>
                        </div>
                      </td>
                      <td>{status}</td>
                    </tr>
                  );
                })}
                <tr style={{ background: 'rgba(0,212,255,0.05)', fontWeight: 700 }}>
                  <td colSpan={3} style={{ color: 'var(--accent)', fontWeight: 700 }}>الإجمالي</td>
                  {DAYS.map(d => {
                    const dayTotal = teachers.reduce((a, t) => a + (tr[t.id]?.dayComm[d] || 0), 0);
                    return <td key={d} style={{ textAlign: 'center', color: 'var(--accent)' }}>{dayTotal}</td>;
                  })}
                  <td style={{ textAlign: 'center', color: 'var(--accent)', fontFamily: 'var(--mono)' }}>{totalComAll}</td>
                  <td style={{ fontFamily: 'var(--mono)', fontWeight: 700, color: 'var(--accent3)', padding: '8px 14px' }}>{totalHrsAll.toFixed(1)}h</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </>
    );
  };

  // ========== MAIN APP RENDER ==========
  const pages: { key: Page; label: string; adminOnly: boolean }[] = [
    { key: 'teachers', label: '👨‍🏫 المعلمين', adminOnly: false },
    { key: 'schedule', label: '📅 الجدول', adminOnly: false },
    { key: 'distribute', label: '⚡ التوزيع', adminOnly: true },
    { key: 'results', label: '📋 النتائج', adminOnly: false },
    { key: 'stats', label: '📊 الإحصائيات', adminOnly: true },
  ];

  const visiblePages = pages.filter(p => !p.adminOnly || isAdmin);

  return (
    <div style={{ position: 'relative', zIndex: 1, minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header style={{
        background: 'linear-gradient(135deg, #0d1b2e 0%, #0a1628 100%)',
        borderBottom: '1px solid var(--border)',
        padding: '0 32px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 64,
        position: 'sticky',
        top: 0,
        zIndex: 100,
        backdropFilter: 'blur(20px)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--accent)', letterSpacing: 2 }}>
          <div style={{ width: 8, height: 8, background: 'var(--accent)', borderRadius: '50%', animation: 'pulse 2s infinite' }} />
          EXAM · SUPERVISOR · ONLINE
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="badge" style={{ background: `${roleColor}22`, color: roleColor }}>{roleLabel}</span>
          <span style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: isConnected ? 'var(--success)' : 'var(--danger)' }} />
            {isConnected ? 'Live' : 'Offline'}
          </span>
          {isAdmin && (
            <button className="btn btn-ghost" onClick={exportCSV}>📥 Export</button>
          )}
          {isAdmin && (
            <button className="btn btn-ghost" onClick={resetAll}>🗑 Reset</button>
          )}
          <button className="btn btn-ghost" onClick={handleLogout}>🚪 خروج</button>
        </div>
      </header>

      {/* Nav Tabs */}
      <div style={{ display: 'flex', gap: 0, background: 'var(--surface)', borderBottom: '1px solid var(--border)', padding: '0 32px', overflowX: 'auto' }}>
        {visiblePages.map(p => (
          <div
            key={p.key}
            className={'nav-tab' + (activePage === p.key ? ' active' : '')}
            onClick={() => setActivePage(p.key)}
          >
            {p.label}
          </div>
        ))}
      </div>

      {/* Main Content */}
      <main style={{ padding: '28px 32px', maxWidth: 1400, margin: '0 auto', width: '100%', flex: 1 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 64, color: 'var(--text2)' }}>
            <div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
            جاري التحميل...
          </div>
        ) : (
          <>
            {activePage === 'teachers' && renderTeachersPage()}
            {activePage === 'schedule' && renderSchedulePage()}
            {activePage === 'distribute' && isAdmin && renderDistributePage()}
            {activePage === 'results' && renderResultsPage()}
            {activePage === 'stats' && isAdmin && renderStatsPage()}
          </>
        )}
      </main>

      {/* Toast */}
      <div id="app-toast" className="toast" />

      {/* Inline styles for components not in globals */}
      <style jsx>{`
        @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(1.4)} }
        @keyframes spin { to { transform: rotate(360deg); } }
        .nav-tab { padding: 14px 24px; font-size: 13px; font-weight: 500; color: var(--text2); cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.2s; white-space: nowrap; user-select: none; }
        .nav-tab:hover { color: var(--text); }
        .nav-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
        .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 20px; }
        .card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }
        .card-title { font-size: 15px; font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 10px; }
        .card-title::before { content:''; width: 3px; height: 18px; background: var(--accent); border-radius: 2px; }
        .btn { display: inline-flex; align-items: center; gap: 8px; padding: 9px 18px; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; border: none; transition: all 0.2s; font-family: var(--sans); }
        .btn-primary { background: var(--accent); color: #000; }
        .btn-primary:hover { background: #00b8d9; transform:translateY(-1px); }
        .btn-demo { background: #8a2be2; color: #fff; border: 1px solid rgba(255,255,255,0.1); }
        .btn-demo:hover { background: #9932cc; transform:translateY(-1px); }
        .btn-ghost { background: transparent; color: var(--text2); border: 1px solid var(--border); }
        .btn-ghost:hover { color:var(--text); border-color: var(--accent); }
        .btn-orange { background: var(--accent2); color: #fff; padding: 12px 32px; font-size: 15px; font-weight: 600; }
        .btn-orange:hover { background: #e55a2b; transform:translateY(-2px); box-shadow: 0 8px 24px rgba(255,107,53,0.3); }
        .table-wrap { overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        thead th { background: var(--surface2); padding: 10px 14px; text-align: left; font-weight: 600; color: var(--text2); font-size: 12px; border-bottom: 1px solid var(--border); white-space: nowrap; }
        tbody tr { border-bottom: 1px solid rgba(30,58,95,0.5); transition: background 0.15s; }
        tbody tr:hover { background: rgba(0,212,255,0.03); }
        tbody td { padding: 10px 14px; color: var(--text); vertical-align: middle; }
        .form-group { margin-bottom: 16px; }
        .form-label { display: block; font-size: 12px; font-weight: 500; color: var(--text2); margin-bottom: 6px; }
        .form-input, .form-select { width: 100%; padding: 9px 13px; background: var(--surface2); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 13px; font-family: var(--sans); }
        .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
        .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
        .stat-card { background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 20px; text-align: center; }
        .stat-number { font-family: var(--mono); font-size: 28px; font-weight: 600; color: var(--accent); display: block; }
        .stat-label { font-size: 12px; color: var(--text2); margin-top: 4px; }
        .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; }
        .badge-blue { background:rgba(0,212,255,0.15); color:var(--accent); }
        .badge-orange { background:rgba(255,107,53,0.15); color:var(--accent2); }
        .badge-green { background:rgba(0,255,157,0.15); color:var(--accent3); }
        .badge-red { background:rgba(255,68,68,0.15); color:var(--danger); }
        .action-btn { background: none; border: none; cursor: pointer; font-size: 14px; padding: 4px 8px; border-radius: 4px; }
        .del-btn { color: var(--danger); }
        .edit-btn { color: var(--accent); margin-right: 6px; }
        .schedule-grid { display: grid; grid-template-columns: 160px repeat(6, 1fr); gap: 4px; font-size: 12px; }
        .sg-header { background: var(--surface2); padding: 10px 8px; text-align: center; font-weight: 600; color: var(--accent); border-radius: 6px; }
        .sg-grade { background: var(--surface2); padding: 10px 12px; font-weight: 500; border-radius: 6px; display: flex; align-items: center; }
        .sg-cell { background: var(--surface2); border-radius: 6px; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
        .sg-cell input, .sg-cell select { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-size: 11px; padding: 4px 6px; font-family: var(--sans); }
        .result-day { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 16px; overflow: hidden; }
        .result-day-header { background: var(--surface2); padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; }
        .result-day-title { font-weight: 600; font-size: 14px; color: var(--accent); display: flex; align-items: center; gap: 10px; }
        .result-day-body { padding: 16px 20px; }
        .result-session { margin-bottom: 16px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
        .result-session-header { background: rgba(0,212,255,0.05); padding: 10px 16px; display: flex; gap: 20px; align-items: center; font-size: 12px; }
        .rs-grade { font-weight: 600; color: var(--text); }
        .rs-time { color: var(--accent); font-family: var(--mono); }
        .rs-subject { color: var(--accent2); }
        .result-com { display: grid; grid-template-columns: 60px 1fr 1fr 100px; gap: 0; font-size: 12px; }
        .rc-cell { padding: 8px 12px; border-bottom: 1px solid rgba(30,58,95,0.4); display: flex; align-items: center; }
        .rc-num { color: var(--text2); font-family: var(--mono); justify-content: center; }
        .toast { position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%) translateY(100px); background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 24px; font-size: 14px; z-index: 999; transition: transform 0.3s ease; min-width: 300px; text-align: center; }
        .toast.show { transform: translateX(-50%) translateY(0); }
        .toast.success { border-color: var(--success); color: var(--success); }
        .toast.error { border-color: var(--danger); color: var(--danger); }
        @media (max-width: 768px) {
          header { padding: 0 16px; }
          main { padding: 16px; }
          .grid-3, .grid-4 { grid-template-columns: 1fr; }
          .grid-2 { grid-template-columns: 1fr; }
          .schedule-grid { grid-template-columns: 120px repeat(6, minmax(80px, 1fr)); }
          .result-com { grid-template-columns: 50px 1fr 1fr 80px; font-size: 11px; }
        }
      `}</style>
    </div>
  );
}

