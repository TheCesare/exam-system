'use client';

export const dynamic = 'force-dynamic';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createClient, RealtimeChannel } from '@supabase/supabase-js';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

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
interface TrackingEntry { totalComm: number; totalHours: number; dayComm: Record<string,number>; assignedSlots: {day:string;start:number;end:number}[]; gradeHistory: {dayIndex:number;grade:string}[]; }
interface CommitteeResult { serial: number; t1: {id:string|null;name:string}; t2: {id:string|null;name:string}; }
interface SessionResult { grade: string; time: string; subject: string; committees: CommitteeResult[]; }
interface StandbyEntry { id: string; name: string; }
interface DistributionResults {
  _version: number;
  assignments: Record<string, SessionResult[]>;
  standbys: Record<string, Record<string, StandbyEntry[]>>;
  tracking: Record<string, TrackingEntry>;
}

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
    // Fix common 12h format issue: "1:00" should be "13:00" if start < 300 (before 5am) and end > start
    if (start < 300 && end > start + 120) start += 720;
    if (end <= start) end += 720;
    let duration = (end - start) / 60;
    // Sanity cap: no exam is longer than 5 hours
    if (duration > 5) duration = 2.0; // fallback to standard
    return { start, end, duration };
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
  const [loginMode, setLoginMode] = useState<'user' | 'admin' | null>(null);
  const [isConnected, setIsConnected] = useState(true);
  const [userCanEditTeachers, setUserCanEditTeachers] = useState(false);

  // Data state
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [teacherOrder, setTeacherOrder] = useState<string[]>([]); // explicit order
  const [schedule, setSchedule] = useState<ScheduleCell[]>([]);
  const [results, setResults] = useState<DistributionResults | null>(null);

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

  // ========== HELPER: Save teacher order to settings ==========
  const saveTeacherOrder = async (ids: string[]) => {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const current = await res.json();
        await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...current, teacher_order: ids })
        });
      }
    } catch { /* silent */ }
  };

  // ========== LOAD SETTINGS ==========
  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        setUserCanEditTeachers(!!data.user_can_edit_teachers);
        if (data.teacher_order && Array.isArray(data.teacher_order)) {
          setTeacherOrder(data.teacher_order);
          return data.teacher_order;
        }
      }
    } catch { /* silent */ }
    return [];
  }, []);

  // ========== LOAD DATA ==========
  const sortTeachersByOrder = useCallback((list: Teacher[], order: string[]): Teacher[] => {
    if (!order || order.length === 0) return list;
    const orderMap = new Map<string, number>();
    order.forEach((id, idx) => orderMap.set(id, idx));
    const maxOrder = order.length;
    return [...list].sort((a, b) => {
      const aIdx = orderMap.has(a.id) ? orderMap.get(a.id)! : maxOrder;
      const bIdx = orderMap.has(b.id) ? orderMap.get(b.id)! : maxOrder;
      if (aIdx !== bIdx) return aIdx - bIdx;
      return 0;
    });
  }, []);

  const loadTeachers = useCallback(async (forcedOrder?: string[]) => {
    try {
      const res = await fetch('/api/teachers');
      if (res.ok) {
        const raw: Teacher[] = await res.json();
        // Use forced order (from settings load) or current state
        const order = forcedOrder || teacherOrder;
        const sorted = sortTeachersByOrder(raw, order);
        setTeachers(sorted);
        // If no saved order yet, initialize from current data
        if (order.length === 0 && raw.length > 0) {
          const ids = raw.map(t => t.id);
          setTeacherOrder(ids);
          saveTeacherOrder(ids);
        }
      }
    } catch { /* silent */ }
  }, [teacherOrder, sortTeachersByOrder]);

  const loadSchedule = useCallback(async () => {
    try {
      const res = await fetch('/api/schedule');
      if (res.ok) {
        const data: ScheduleCell[] = await res.json();
        setSchedule(data);
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
        if (data && data.data) {
          const d = data.data;
          // v6+ results must have _version >= 6. Old results → discard.
          if (!d._version || d._version < 8) {
            await fetch('/api/results', { method: 'DELETE' });
            setResults(null);
          } else {
            setResults(d);
          }
        }
      }
    } catch { /* silent */ }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    // Load settings first to get teacher_order
    const order = await loadSettings();
    // Pass the fresh order directly to loadTeachers
    Promise.all([loadTeachers(order.length > 0 ? order : undefined), loadSchedule(), loadResults()])
      .finally(() => setLoading(false));
  }, [loadTeachers, loadSchedule, loadResults, loadSettings]);

  // ========== SUPABASE REALTIME ==========
  useEffect(() => {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) return;

    const sb = createClient(supabaseUrl, supabaseKey);

    const teachersCh = sb.channel('teachers-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'teachers' }, () => {
        loadTeachers();
      })
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED');
      });

    const scheduleCh = sb.channel('schedule-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schedule_cells' }, () => {
        loadSchedule();
      })
      .subscribe();

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

  const toggleUserEditPermission = async (val: boolean) => {
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_can_edit_teachers: val })
      });
      setUserCanEditTeachers(val);
      showToast(val ? 'User edit permission enabled' : 'User edit permission disabled', 'info');
    } catch { showToast('Error updating settings', 'error'); }
  };

  // ========== AUTH ==========
  const handleLogin = async (role: 'user' | 'admin') => {
    if (!password.trim()) { setLoginError('Please enter the password'); return; }
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, role })
      });
      const data = await res.json();
      if (data.success) {
        setView(data.role);
        loadAll();
        loadSettings();
      } else {
        setLoginError(data.message || 'Wrong password');
      }
    } catch { setLoginError('Connection error'); }
  };

  const handleLogout = () => {
    setView('login');
    setPassword('');
    setLoginError('');
    setLoginMode(null);
    setTeachers([]);
    setSchedule([]);
    setResults(null);
    setUserCanEditTeachers(false);
  };

  // ========== TEACHER ACTIONS ==========

  const deleteTeacher = async (id: string) => {
    if (!isAdmin) { showToast('الحذف للادمن فقط', 'error'); return; }
    if (!confirm('Delete this teacher?')) return;
    try {
      await fetch(`/api/teachers?id=${id}`, { method: 'DELETE' });
      // Remove from order
      const newOrder = teacherOrder.filter(tid => tid !== id);
      setTeacherOrder(newOrder);
      saveTeacherOrder(newOrder);
      loadTeachers();
      showToast('Teacher deleted', 'success');
    } catch { showToast('Error deleting', 'error'); }
  };

  const startEdit = (t: Teacher) => {
    if (!isAdmin && !userCanEditTeachers) { showToast('مفيش صلاحية تعديل - اسأل الادمن', 'error'); return; }
    setEditTeacherId(t.id);
    setFormName(t.name);
    setFormSubject(t.subject);
    setFormNotes(t.notes);
    setShowAddTeacher(true);
  };

  const saveTeacher = async () => {
    if (!formName.trim() || !formSubject) { showToast('Please complete all fields', 'error'); return; }
    // User (with permission) can add and edit
    if (!isAdmin && !userCanEditTeachers) { showToast('مفيش صلاحية - اسأل الادمن', 'error'); return; }
    try {
      if (editTeacherId) {
        await fetch('/api/teachers', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: editTeacherId, name: formName.trim(), subject: formSubject, notes: formNotes.trim() })
        });
        showToast('Teacher updated', 'success');
        // Order stays the same - no change to teacherOrder
      } else {
        const res = await fetch('/api/teachers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: formName.trim(), subject: formSubject, notes: formNotes.trim() })
        });
        if (res.ok) {
          const newTeacher = await res.json();
          const newOrder = [...teacherOrder, newTeacher.id];
          setTeacherOrder(newOrder);
          saveTeacherOrder(newOrder);
        }
        showToast('Teacher added successfully', 'success');
      }
      cancelEdit();
      loadTeachers();
    } catch { showToast('Error saving teacher', 'error'); }
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
      // Reset order - will be re-initialized from fresh data
      setTeacherOrder([]);
      loadTeachers();
      showToast('Injected 200 Mock Teachers Successfully!', 'success');
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
        // Reset order - will be re-initialized from fresh data
        setTeacherOrder([]);
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

  // ========== DISTRIBUTION ENGINE v4 ==========
  const runDistribution = () => {
    if (teachers.length === 0) { showToast('Error: Registry empty!', 'error'); return; }

    const ruleSubject = (document.getElementById('rule-subject') as HTMLInputElement)?.checked ?? true;
    const ruleDayLimit = (document.getElementById('rule-daylimit') as HTMLInputElement)?.checked ?? true;
    const ruleNotes = (document.getElementById('rule-notes') as HTMLInputElement)?.checked ?? true;

    // ---- All teachers in ONE pool (admin participates normally) ----
    const adminTeachers = teachers.filter(t => t.subject === 'Admin');

    // ---- Initialize tracking ----
    const tracking: Record<string, TrackingEntry> = {};
    teachers.forEach(t => {
      tracking[t.id] = { totalComm: 0, totalHours: 0, dayComm: {} as Record<string,number>, assignedSlots: [], gradeHistory: [] };
      DAYS.forEach(d => { tracking[t.id].dayComm[d] = 0; });
    });

    // ---- Build exam slots grouped by day (chronological order) ----
    type Slot = { day: string; dayIndex: number; grade: string; stage: string; subject: string; time: string; timeInfo: ReturnType<typeof parseTimeRange>; comId: number };
    const slotsByDay: Record<string, Slot[]> = {};
    DAYS.forEach((d, i) => { slotsByDay[d] = []; });
    DAYS.forEach((day, dayIndex) => {
      GRADES.forEach(grade => {
        const cell = scheduleBuffer[`${grade}__${day}`];
        if (cell && cell.committees > 0) {
          const timeInfo = parseTimeRange(cell.time || DEFAULT_TIMES[grade] || '9:00-10:30');
          for (let c = 1; c <= cell.committees; c++) {
            slotsByDay[day].push({ day, dayIndex, grade, stage: getStage(grade), subject: cell.subject || '', time: cell.time || DEFAULT_TIMES[grade] || '9:00-10:30', timeInfo, comId: c });
          }
        }
      });
    });

    // ---- Build final assignments structure ----
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

    // ---- Helper: Stage notes — HARD constraint ----
    const canSuperviseStage = (teacher: Teacher, slotStage: string): boolean => {
      if (!ruleNotes) return true;
      if (!teacher.notes || teacher.notes.trim() === '') return true;
      const n = teacher.notes.toLowerCase();
      const allowed: string[] = [];
      if (/\b(primary|pri)\b/i.test(n) || n.includes('\u0627\u0628\u062a\u062f\u0627\u0626\u064a')) allowed.push('primary');
      if (/\bprep\b/i.test(n) || n.includes('\u0627\u0639\u062f\u0627\u062f\u064a')) allowed.push('prep');
      if (/\b(secondary|sec)\b/i.test(n) || n.includes('\u062b\u0627\u0646\u0648\u064a')) allowed.push('sec');
      if (allowed.length === 0) return true;
      return allowed.includes(slotStage);
    };

    // ---- Helper: Consecutive-day same-grade check ----
    const wasSameGradeAdjacent = (tr: TrackingEntry, slot: Slot): boolean => {
      return tr.gradeHistory.some(h => Math.abs(h.dayIndex - slot.dayIndex) === 1 && h.grade === slot.grade);
    };

    // ---- Helper: Fisher-Yates shuffle ----
    const shuffle = <T,>(arr: T[]): T[] => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };

    // ---- Admin minimum assignment tracking ----
    const adminAssignmentCount: Record<string, number> = {};
    adminTeachers.forEach(t => { adminAssignmentCount[t.id] = 0; });
    const adminMinTarget = 2; // each admin gets at least 2 assignments
    let totalAdminAssigned = 0;

    // ---- Core: Find best teacher for a slot ----
    // HARD RULES: own-subject, stage notes, NO same-day double, time overlap
    // Scoring: hours dominate (200x), tiny noise (0.2) for variety
    const findBest = (
      blockedId: string | null,
      slot: Slot,
      pool: Teacher[],
      relaxAdj: boolean
    ): Teacher | null => {
      const candidates: { teacher: Teacher; score: number }[] = [];
      for (const t of pool) {
        if (blockedId && t.id === blockedId) continue;
        const tr = tracking[t.id];
        // HARD: No own-subject supervision
        if (ruleSubject && slot.subject && t.subject === slot.subject) continue;
        // HARD: Stage notes filtering
        if (!canSuperviseStage(t, slot.stage)) continue;
        // HARD: No time overlap on same day
        if (tr.assignedSlots.some(s => s.day === slot.day && !(slot.timeInfo.end <= s.start || slot.timeInfo.start >= s.end))) continue;
        // HARD: MAX 1 committee per teacher per day (NEVER relaxed)
        if (ruleDayLimit && tr.dayComm[slot.day] >= 1) continue;
        // SOFT: No same grade on consecutive days (can be relaxed)
        if (!relaxAdj && wasSameGradeAdjacent(tr, slot)) continue;
        // Scoring: hours are king, tiny random for variety between equal candidates
        const isAdmin = t.subject === 'Admin';
        const adminBonus = (adminAssignmentCount[t.id] || 0) < adminMinTarget ? -3 : 0;
        const score = tr.totalHours * 200 + tr.totalComm * 5 + (isAdmin ? 3 + adminBonus : 0) + Math.random() * 0.2;
        candidates.push({ teacher: t, score });
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => a.score - b.score);
      const best = candidates[0].score;
      const topGroup = candidates.filter(c => c.score <= best + 0.5);
      return topGroup[Math.floor(Math.random() * topGroup.length)].teacher;
    };

    // ---- Fallback 2: Relax stage constraints only (keep own-subject, 1-per-day + time) ----
    const findBestRelaxed = (blockedId: string | null, slot: Slot, pool: Teacher[]): Teacher | null => {
      const candidates: { teacher: Teacher; score: number }[] = [];
      for (const t of pool) {
        if (blockedId && t.id === blockedId) continue;
        const tr = tracking[t.id];
        // HARD: Still no own-subject supervision even in relaxed mode
        if (ruleSubject && slot.subject && t.subject === slot.subject) continue;
        if (tr.assignedSlots.some(s => s.day === slot.day && !(slot.timeInfo.end <= s.start || slot.timeInfo.start >= s.end))) continue;
        if (ruleDayLimit && tr.dayComm[slot.day] >= 1) continue;
        const score = tr.totalHours * 200 + tr.totalComm * 5 + Math.random() * 0.2;
        candidates.push({ teacher: t, score });
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => a.score - b.score);
      return candidates[0].teacher;
    };

    // ---- Fallback 3: Allow 2nd assignment same day (only time overlap + own-subject blocked) ----
    const findBestForceDay = (blockedId: string | null, slot: Slot, pool: Teacher[]): Teacher | null => {
      const candidates: { teacher: Teacher; score: number }[] = [];
      for (const t of pool) {
        if (blockedId && t.id === blockedId) continue;
        const tr = tracking[t.id];
        // HARD: Still no own-subject supervision even in force-day mode
        if (ruleSubject && slot.subject && t.subject === slot.subject) continue;
        if (tr.assignedSlots.some(s => s.day === slot.day && !(slot.timeInfo.end <= s.start || slot.timeInfo.start >= s.end))) continue;
        const score = tr.totalHours * 200 + tr.totalComm * 5 + (tr.dayComm[slot.day] || 0) * 50 + Math.random() * 0.2;
        candidates.push({ teacher: t, score });
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => a.score - b.score);
      return candidates[0].teacher;
    };

    // ---- Process each day chronologically, shuffle slots within day for variety ----
    let standbyCount = 0;
    const allPool = [...teachers]; // ALL teachers including admin

    for (const day of DAYS) {
      const daySlots = shuffle(slotsByDay[day]);
      if (daySlots.length === 0) continue;

      for (const slot of daySlots) {
        let t1: Teacher | null = null;
        let t2: Teacher | null = null;

        // T1: strict → relax consecutive → relax subject+stage → allow 2nd same-day
        t1 = findBest(null, slot, allPool, false);
        if (!t1) t1 = findBest(null, slot, allPool, true); // relax consecutive-day
        if (!t1) t1 = findBestRelaxed(null, slot, allPool); // relax subject + stage
        if (!t1) t1 = findBestForceDay(null, slot, allPool); // allow 2nd assignment same day

        if (t1) {
          const tr = tracking[t1.id];
          tr.totalComm++; tr.dayComm[slot.day]++;
          tr.assignedSlots.push({ day: slot.day, start: slot.timeInfo.start, end: slot.timeInfo.end });
          tr.gradeHistory.push({ dayIndex: slot.dayIndex, grade: slot.grade });
        } else { standbyCount++; }

        // T2: same pool, blocked=T1, cascade fallbacks
        const blocked = t1?.id || null;
        t2 = findBest(blocked, slot, allPool, false);
        if (!t2) t2 = findBest(blocked, slot, allPool, true);
        if (!t2) t2 = findBestRelaxed(blocked, slot, allPool);
        if (!t2) t2 = findBestForceDay(blocked, slot, allPool);

        if (t2) {
          if (t2.subject === 'Admin') {
            adminAssignmentCount[t2.id] = (adminAssignmentCount[t2.id] || 0) + 1;
            totalAdminAssigned++;
          }
          const tr = tracking[t2.id];
          tr.totalComm++; tr.dayComm[slot.day]++;
          tr.assignedSlots.push({ day: slot.day, start: slot.timeInfo.start, end: slot.timeInfo.end });
          tr.gradeHistory.push({ dayIndex: slot.dayIndex, grade: slot.grade });
        } else { standbyCount++; }

        // Record assignment
        const session = finalAssignments[slot.day].find(s => s.grade === slot.grade && s.time === slot.time);
        if (session) {
          session.committees.push({
            serial: slot.comId,
            t1: t1 ? { id: t1.id, name: t1.name } : { id: null, name: '—' },
            t2: t2 ? { id: t2.id, name: t2.name } : { id: null, name: '—' }
          });
        }
      }
    }

    // ---- Post-distribution: Recalculate hours from ACTUAL assignments (source of truth) ----
    // This eliminates any tracking accumulation bugs
    const teacherCommCount: Record<string, number> = {};
    const teacherHoursFromAssign: Record<string, number> = {};
    const teacherDayCommFromAssign: Record<string, Record<string, number>> = {};
    const teacherSlotsFromAssign: Record<string, {day:string;start:number;end:number}[]> = {};
    teachers.forEach(t => {
      teacherCommCount[t.id] = 0;
      teacherHoursFromAssign[t.id] = 0;
      teacherDayCommFromAssign[t.id] = {};
      teacherSlotsFromAssign[t.id] = [];
    });

    for (const day of DAYS) {
      for (const sess of finalAssignments[day]) {
        const sessTimeInfo = parseTimeRange(sess.time || '9:00-10:30');
        for (const c of sess.committees) {
          [c.t1, c.t2].forEach(who => {
            if (!who.id) return;
            teacherCommCount[who.id] = (teacherCommCount[who.id] || 0) + 1;
            // Deduplicate: same day + same time = counted once
            const slotKey = day + '_' + sessTimeInfo.start + '_' + sessTimeInfo.end;
            const existing = teacherSlotsFromAssign[who.id];
            if (!existing.some(s => s.day === day && s.start === sessTimeInfo.start && s.end === sessTimeInfo.end)) {
              existing.push({ day, start: sessTimeInfo.start, end: sessTimeInfo.end });
              teacherHoursFromAssign[who.id] += sessTimeInfo.duration;
            }
            // Day committee count
            if (!teacherDayCommFromAssign[who.id]) teacherDayCommFromAssign[who.id] = {};
            teacherDayCommFromAssign[who.id][day] = (teacherDayCommFromAssign[who.id][day] || 0) + 1;
          });
        }
      }
    }

    // Override tracking with verified data from assignments
    teachers.forEach(t => {
      if (tracking[t.id]) {
        tracking[t.id].totalComm = teacherCommCount[t.id] || 0;
        tracking[t.id].totalHours = teacherHoursFromAssign[t.id] || 0;
        tracking[t.id].dayComm = teacherDayCommFromAssign[t.id] || ({} as Record<string,number>);
        tracking[t.id].assignedSlots = teacherSlotsFromAssign[t.id] || [];
      }
    });

    // ---- Post-distribution: Ensure admin gets at least 2 assignments ----
    for (const admin of adminTeachers) {
      const adminComm = tracking[admin.id].totalComm;
      if (adminComm >= adminMinTarget) continue;
      // Try to swap: find a teacher with > average hours who has an assignment
      // that admin could take (passing all constraints)
      const allTeacherHours = teachers.map(t => tracking[t.id]?.totalHours || 0).filter(h => h > 0);
      const avgH = allTeacherHours.length > 0 ? allTeacherHours.reduce((a, b) => a + b, 0) / allTeacherHours.length : 0;
      const overburdened = teachers.filter(t => t.id !== admin.id && tracking[t.id]?.totalHours > avgH);
      // Sort by most overburdened first
      overburdened.sort((a, b) => (tracking[b.id]?.totalHours || 0) - (tracking[a.id]?.totalHours || 0));

      for (const victim of overburdened) {
        if (tracking[admin.id].totalComm >= adminMinTarget) break;
        // Find an assignment of victim that admin can take
        for (const day of DAYS) {
          if (tracking[admin.id].totalComm >= adminMinTarget) break;
          const daySlots = teacherSlotsFromAssign[victim.id].filter(s => s.day === day);
          if (daySlots.length === 0) continue;
          // Admin already has assignment on this day?
          if ((tracking[admin.id].dayComm[day] || 0) >= 1) continue;
          // Find the session+committee for this slot
          for (const sess of finalAssignments[day]) {
            if (tracking[admin.id].totalComm >= adminMinTarget) break;
            const sessTimeInfo = parseTimeRange(sess.time || '9:00-10:30');
            if (daySlots[0].start !== sessTimeInfo.start || daySlots[0].end !== sessTimeInfo.end) continue;
            // Check admin constraints
            if (ruleSubject && sess.subject && admin.subject === sess.subject) continue;
            if (!canSuperviseStage(admin, getStage(sess.grade))) continue;
            // Check admin no time overlap (should be fine since we checked dayComm above)
            if (tracking[admin.id].assignedSlots.some(s => s.day === day && !(sessTimeInfo.end <= s.start || sessTimeInfo.start >= s.end))) continue;
            // Find which position (t1 or t2) victim has in this session
            for (const c of sess.committees) {
              if (c.t1?.id === victim.id || c.t2?.id === victim.id) {
                // Check consecutive grade constraint
                if (wasSameGradeAdjacent(tracking[admin.id], { day, dayIndex: DAYS.indexOf(day), grade: sess.grade, stage: getStage(sess.grade), subject: sess.subject, time: sess.time, timeInfo: sessTimeInfo, comId: 0 })) continue;
                // Do the swap
                const isT1 = c.t1?.id === victim.id;
                const swappedTeacher = isT1 ? c.t1 : c.t2;
                if (isT1) { c.t1 = { id: admin.id, name: admin.name }; }
                else { c.t2 = { id: admin.id, name: admin.name }; }
                // Update tracking: remove from victim, add to admin
                tracking[victim.id].totalComm--;
                tracking[victim.id].dayComm[day] = Math.max(0, (tracking[victim.id].dayComm[day] || 0) - 1);
                tracking[admin.id].totalComm++;
                tracking[admin.id].dayComm[day] = (tracking[admin.id].dayComm[day] || 0) + 1;
                tracking[admin.id].assignedSlots.push({ day, start: sessTimeInfo.start, end: sessTimeInfo.end });
                tracking[admin.id].gradeHistory.push({ dayIndex: DAYS.indexOf(day), grade: sess.grade });
                break;
              }
            }
          }
        }
      }
    }

    // ---- Post-distribution: BALANCE PASS ----
    // Iteratively swap assignments from overburdened → underburdened teachers
    // to minimize the max-min spread in hours
    const BALANCE_ITERATIONS = 150;
    const recalcHours = () => {
      teachers.forEach(t => {
        const slots = tracking[t.id].assignedSlots || [];
        const seen = new Set<string>();
        let hrs = 0;
        slots.forEach(s => {
          const key = s.day + '_' + s.start + '_' + s.end;
          if (!seen.has(key)) { seen.add(key); hrs += (s.end - s.start) / 60; }
        });
        tracking[t.id].totalHours = hrs;
      });
    };
    recalcHours(); // recalc after admin swaps first

    for (let iter = 0; iter < BALANCE_ITERATIONS; iter++) {
      const active = teachers.filter(t => tracking[t.id].totalComm > 0);
      if (active.length < 2) break;
      const sorted = [...active].sort((a, b) => tracking[b.id].totalHours - tracking[a.id].totalHours);
      const maxH = tracking[sorted[0].id].totalHours;
      const minH = tracking[sorted[sorted.length - 1].id].totalHours;
      if (maxH - minH <= 1.0) break; // spread ≤ 1h — good enough

      let swapped = false;
      // Try top-3 donors × bottom-3 recipients
      for (let di = 0; di < Math.min(sorted.length, 3) && !swapped; di++) {
        const donor = sorted[di];
        // Don't strip admins below their minimum
        const isDonorAdmin = donor.subject === 'Admin';
        if (tracking[donor.id].totalComm <= 1) continue;
        if (isDonorAdmin && tracking[donor.id].totalComm <= adminMinTarget) continue;

        for (let ri = sorted.length - 1; ri >= Math.max(0, sorted.length - 3) && !swapped; ri--) {
          const recip = sorted[ri];
          if (donor.id === recip.id) continue;
          if (tracking[donor.id].totalHours <= tracking[recip.id].totalHours + 0.3) continue;

          // Try each day where donor has an assignment and recipient doesn't
          for (const day of DAYS) {
            if (swapped) break;
            if ((tracking[donor.id].dayComm[day] || 0) === 0) continue;
            if ((tracking[recip.id].dayComm[day] || 0) >= 1) continue;

            const donorSlot = tracking[donor.id].assignedSlots.find(s => s.day === day);
            if (!donorSlot) continue;

            // Find the session matching donor's slot
            for (const sess of finalAssignments[day]) {
              if (swapped) break;
              const sessTI = parseTimeRange(sess.time || '9:00-10:30');
              if (donorSlot.start !== sessTI.start || donorSlot.end !== sessTI.end) continue;

              // Check recipient constraints
              if (ruleSubject && sess.subject && recip.subject === sess.subject) continue;
              if (!canSuperviseStage(recip, getStage(sess.grade))) continue;
              if (tracking[recip.id].assignedSlots.some(s => s.day === day && !(sessTI.end <= s.start || sessTI.start >= s.end))) continue;
              if (wasSameGradeAdjacent(tracking[recip.id], { day, dayIndex: DAYS.indexOf(day), grade: sess.grade, stage: getStage(sess.grade), subject: sess.subject, time: sess.time, timeInfo: sessTI, comId: 0 })) continue;

              // Find donor in this session's committees
              for (const c of sess.committees) {
                const isT1 = c.t1?.id === donor.id;
                const isT2 = c.t2?.id === donor.id;
                if (!isT1 && !isT2) continue;

                // Execute swap
                if (isT1) c.t1 = { id: recip.id, name: recip.name };
                else c.t2 = { id: recip.id, name: recip.name };

                tracking[donor.id].totalComm--;
                tracking[donor.id].dayComm[day] = Math.max(0, (tracking[donor.id].dayComm[day] || 0) - 1);
                tracking[donor.id].assignedSlots = tracking[donor.id].assignedSlots.filter(s => !(s.day === day && s.start === donorSlot.start && s.end === donorSlot.end));
                tracking[donor.id].gradeHistory = tracking[donor.id].gradeHistory.filter(h => !(h.dayIndex === DAYS.indexOf(day) && h.grade === sess.grade));

                tracking[recip.id].totalComm++;
                tracking[recip.id].dayComm[day] = (tracking[recip.id].dayComm[day] || 0) + 1;
                tracking[recip.id].assignedSlots.push({ day, start: sessTI.start, end: sessTI.end });
                tracking[recip.id].gradeHistory.push({ dayIndex: DAYS.indexOf(day), grade: sess.grade });

                swapped = true;
                break;
              }
            }
          }
        }
      }
      if (!swapped) break; // no valid swap found
      recalcHours(); // update hours after each swap
    }

    // Final hour recalculation after all balancing
    recalcHours();

    // ---- Sort committees by serial within each session (1, 2, 3...) ----
    for (const day of DAYS) {
      for (const sess of finalAssignments[day]) {
        sess.committees.sort((a, b) => a.serial - b.serial);
      }
    }

    // ---- Post-distribution: STANDBY ASSIGNMENT ----
    // 1 standby teacher per stage per day from unassigned teachers
    // CRITICAL: Standby must NOT be the same subject as any exam that day for that stage
    // Rotation: prefer teachers who weren't standby yesterday, fewest total standby days
    const STAGES_LIST = ['primary', 'prep', 'sec'] as const;
    const STANDBY_PER_STAGE = 1;
    const standbys: Record<string, Record<string, StandbyEntry[]>> = {};
    DAYS.forEach(d => { standbys[d] = {}; STAGES_LIST.forEach(s => { standbys[d][s] = []; }); });

    // Track standby count per teacher for rotation fairness
    const teacherStandbyCount: Record<string, number> = {};
    teachers.forEach(t => { teacherStandbyCount[t.id] = 0; });

    // Track which teachers are already standby for another stage today
    const todayStandby: Record<string, Set<string>> = {};
    DAYS.forEach(d => { todayStandby[d] = new Set(); });

    for (let di = 0; di < DAYS.length; di++) {
      const day = DAYS[di];

      for (const stage of STAGES_LIST) {
        // Only assign standby if there are exams for this stage on this day
        const stageSessions = (finalAssignments[day] || []).filter(s => getStage(s.grade) === stage);
        if (stageSessions.length === 0) continue;

        // Collect subjects being examined today for this stage
        const dayStageSubjects = new Set<string>();
        stageSessions.forEach(s => { if (s.subject) dayStageSubjects.add(s.subject); });

        // Find teachers NOT assigned on this day who can supervise this stage
        // AND whose subject doesn't match any exam subject for this stage today
        let candidates = teachers.filter(t => {
          if ((tracking[t.id].dayComm[day] || 0) >= 1) return false;
          if (todayStandby[day].has(t.id)) return false; // already standby for another stage today
          if (!canSuperviseStage(t, stage)) return false;
          // CRITICAL: Don't pick a teacher whose subject is being examined today
          if (ruleSubject && t.subject && dayStageSubjects.has(t.subject)) return false;
          return true;
        });

        // Rotation: deprioritize teachers who were standby YESTERDAY for ANY stage
        const yesterdayStandby = new Set<string>();
        if (di > 0) {
          const prevDay = DAYS[di - 1];
          for (const st of STAGES_LIST) {
            (standbys[prevDay][st] || []).forEach(s => yesterdayStandby.add(s.id));
          }
        }
        candidates.sort((a, b) => {
          const aWasYesterday = yesterdayStandby.has(a.id) ? 100 : 0;
          const bWasYesterday = yesterdayStandby.has(b.id) ? 100 : 0;
          return (teacherStandbyCount[a.id] + aWasYesterday) - (teacherStandbyCount[b.id] + bWasYesterday);
        });

        // Pick up to STANDBY_PER_STAGE
        const picked = candidates.slice(0, STANDBY_PER_STAGE);
        standbys[day][stage] = picked.map(t => ({ id: t.id, name: t.name }));

        // Track rotation count and mark as standby for today (so same teacher isn't picked for another stage)
        for (const s of picked) {
          teacherStandbyCount[s.id]++;
          todayStandby[day].add(s.id);
        }
      }
    }

    // ---- Post-distribution verification ----
    const violations: string[] = [];
    // V-Check 1: Own-subject supervision
    if (ruleSubject) {
      for (const day of DAYS) {
        for (const sess of finalAssignments[day]) {
          for (const c of sess.committees) {
            [c.t1, c.t2].forEach(who => {
              if (who.id) {
                const tch = teachers.find(x => x.id === who.id);
                if (tch && tch.subject === sess.subject) violations.push(`${tch.name} -> own subject (${sess.subject}) on ${day}`);
              }
            });
          }
        }
      }
    }
    // V-Check 2: Time overlap
    for (const t of teachers) {
      const tr = tracking[t.id];
      for (let i = 0; i < tr.assignedSlots.length; i++) {
        for (let j = i + 1; j < tr.assignedSlots.length; j++) {
          const a = tr.assignedSlots[i], b = tr.assignedSlots[j];
          if (a.day === b.day && !(a.end <= b.start || b.end <= a.start)) {
            violations.push(`${t.name} -> time overlap on ${a.day}`);
          }
        }
      }
    }
    // V-Check 3: Same-day double assignment (should NEVER happen now)
    for (const t of teachers) {
      const tr = tracking[t.id];
      for (const day of DAYS) {
        if ((tr.dayComm[day] || 0) > 1) {
          violations.push(`${t.name} -> 2+ committees on ${day} (HARD RULE VIOLATED)`);
        }
      }
    }
    // V-Check 4: Stage notes compliance
    if (ruleNotes) {
      for (const day of DAYS) {
        for (const sess of finalAssignments[day]) {
          const stage = getStage(sess.grade);
          for (const c of sess.committees) {
            [c.t1, c.t2].forEach(who => {
              if (who.id) {
                const tch = teachers.find(x => x.id === who.id);
                if (tch && !canSuperviseStage(tch, stage)) violations.push(`${tch.name} -> wrong stage (${stage}) notes="${tch.notes}" on ${day}`);
              }
            });
          }
        }
      }
    }

    // ---- Build summary statistics (from verified tracking) ----
    const allH = teachers.map(t => tracking[t.id]?.totalHours || 0);
    const avgAll = allH.length ? allH.reduce((a, b) => a + b, 0) / allH.length : 0;
    const spread = allH.length ? Math.sqrt(allH.reduce((s, h) => s + (h - avgAll) ** 2, 0) / allH.length) : 0;
    let msg = `v8 | Avg: ${avgAll.toFixed(1)}h | Spread: ${spread.toFixed(1)} | Min: ${allH.length ? Math.min(...allH).toFixed(1) : 0}h | Max: ${allH.length ? Math.max(...allH).toFixed(1) : 0}h`;
    // Count total standby assigned
    const totalStandby = Object.values(standbys).reduce((a, daySt) => a + Object.values(daySt).reduce((b, stList) => b + stList.length, 0), 0);
    if (totalStandby > 0) msg += ` | ${totalStandby} standby (${STANDBY_PER_STAGE}/stage/day)`;
    if (standbyCount > 0) msg += ` | ${standbyCount} unfilled`;
    if (violations.length > 0) {
      msg += ` | ${violations.length} violations (check console)`;
      console.warn('[Distribution v8] Violations:', violations);
    } else {
      console.log('[Distribution v8] All constraints passed!');
    }

    const newResults: DistributionResults = { _version: 8, assignments: finalAssignments, standbys, tracking };
    setResults(newResults);
    fetch('/api/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: newResults }) });
    showToast(msg, standbyCount > 0 || violations.length > 0 ? 'error' : 'success');
    setActivePage('results');
  };

  // ========== EXPORT CSV ==========
  const exportCSV = () => {
    if (!results?.assignments) return;
    let csv = 'Day,Grade,Time,Subject,Committee,Supervisor1,Supervisor2,Role\n';
    DAYS.forEach(day => {
      const sessions = results.assignments[day] || [];
      sessions.forEach(s => {
        s.committees.forEach(c => {
          csv += `"${day}","${s.grade}","${s.time}","${s.subject || ''}","Room ${c.serial}","${c.t1.name}","${c.t2.name}","Primary"\n`;
        });
      });
      if (results.standbys?.[day]) {
        const STAGE_CSV: Record<string, string> = { primary: 'Primary', prep: 'Prep', sec: 'Secondary' };
        for (const stage of ['primary', 'prep', 'sec']) {
          for (const s of (results.standbys[day][stage] || [])) {
            csv += `"${day}","${STAGE_CSV[stage]}","","","Standby","${s.name}","","Standby"\n`;
          }
        }
      }
    });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'perfect_schedule.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  // ========== EXPORT PDF (A4 per grade per day) ==========
  const exportPDF = () => {
    if (!results?.assignments) return;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = 210, pageH = 297, margin = 15;
    let firstPage = true;

    for (const day of DAYS) {
      const sessions = results.assignments[day] || [];
      for (const session of sessions) {
        if (session.committees.length === 0) continue;

        if (!firstPage) doc.addPage();
        firstPage = false;

        // Header
        doc.setFontSize(16);
        doc.setFont('helvetica', 'bold');
        doc.text('Exam Supervision Schedule', pageW / 2, margin + 5, { align: 'center' });

        doc.setFontSize(11);
        doc.setFont('helvetica', 'normal');
        doc.text(`Day: ${day}`, margin, margin + 18);
        doc.text(`Grade: ${session.grade}`, margin + 80, margin + 18);
        doc.text(`Time: ${session.time}`, margin, margin + 26);
        doc.text(`Subject: ${session.subject || '-'}`, margin + 80, margin + 26);

        // Line separator
        doc.setDrawColor(100);
        doc.line(margin, margin + 30, pageW - margin, margin + 30);

        // Table data
        const body = session.committees.map(c => [
          `Room ${c.serial}`,
          c.t1.name,
          '',
          c.t2.name,
          ''
        ]);

        autoTable(doc, {
          startY: margin + 35,
          head: [['Room', 'Lead Supervisor', 'Signature', 'Associate Supervisor', 'Signature']],
          body: body,
          theme: 'grid',
          styles: { fontSize: 10, cellPadding: 3, halign: 'center' },
          headStyles: { fillColor: [30, 58, 95], textColor: 255, fontStyle: 'bold', halign: 'center' },
          columnStyles: {
            0: { cellWidth: 25 },
            1: { cellWidth: 50, halign: 'left' },
            2: { cellWidth: 35 },
            3: { cellWidth: 50, halign: 'left' },
            4: { cellWidth: 35 }
          },
          didDrawCell: (data) => {
            // Draw signature box in signature columns (index 2 and 4)
            if ((data.column.index === 2 || data.column.index === 4) && data.section === 'body') {
              const x = data.cell.x + 2;
              const y = data.cell.y + 2;
              const w = data.cell.width - 4;
              const h = data.cell.height - 4;
              doc.setDrawColor(150);
              doc.setLineWidth(0.3);
              doc.rect(x, y, w, h);
              // Small label under box
              doc.setFontSize(7);
              doc.setTextColor(150);
              doc.text('Signature', data.cell.x + data.cell.width / 2, data.cell.y + data.cell.height - 1, { align: 'center' });
              doc.setTextColor(0);
            }
          },
          margin: { left: margin, right: margin }
        });

        // Footer
        const finalY = (doc as any).lastAutoTable?.finalY || margin + 35 + 20;
        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text('Exam Supervisor System - Auto Generated', pageW / 2, pageH - 10, { align: 'center' });
      }

      // Add standby page for this day (after all grades)
      const daySt = results.standbys?.[day];
      const hasDayStandby = daySt && Object.values(daySt).some(s => s.length > 0);
      if (hasDayStandby) {
        if (!firstPage) doc.addPage();
        firstPage = false;

        doc.setFontSize(16);
        doc.setFont('helvetica', 'bold');
        doc.text('Standby Supervisors', pageW / 2, margin + 5, { align: 'center' });

        doc.setFontSize(11);
        doc.setFont('helvetica', 'normal');
        doc.text(`Day: ${day}`, margin, margin + 18);

        doc.setDrawColor(100);
        doc.line(margin, margin + 22, pageW - margin, margin + 22);

        const STAGE_PDF: Record<string, string> = { primary: 'Primary Stage', prep: 'Prep Stage', sec: 'Secondary Stage' };
        const standbyBody: string[][] = [];
        for (const stage of ['primary', 'prep', 'sec']) {
          const list = daySt[stage] || [];
          if (list.length === 0) continue;
          list.forEach((s, i) => {
            standbyBody.push([i === 0 ? STAGE_PDF[stage] : '', s.name, '', '']);
          });
        }

        autoTable(doc, {
          startY: margin + 28,
          head: [['Stage', 'Standby Supervisor', 'Signature', 'Notes']],
          body: standbyBody,
          theme: 'grid',
          styles: { fontSize: 10, cellPadding: 3, halign: 'center' },
          headStyles: { fillColor: [180, 120, 20], textColor: 255, fontStyle: 'bold', halign: 'center' },
          columnStyles: {
            0: { cellWidth: 40, halign: 'left' },
            1: { cellWidth: 55, halign: 'left' },
            2: { cellWidth: 35 },
            3: { cellWidth: 40 },
          },
          didDrawCell: (data) => {
            if (data.column.index === 2 && data.section === 'body') {
              const x = data.cell.x + 2;
              const y = data.cell.y + 2;
              const w = data.cell.width - 4;
              const h = data.cell.height - 4;
              doc.setDrawColor(150);
              doc.setLineWidth(0.3);
              doc.rect(x, y, w, h);
              doc.setFontSize(7);
              doc.setTextColor(150);
              doc.text('Signature', data.cell.x + data.cell.width / 2, data.cell.y + data.cell.height - 1, { align: 'center' });
              doc.setTextColor(0);
            }
          },
          margin: { left: margin, right: margin }
        });

        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text('Exam Supervisor System - Auto Generated', pageW / 2, pageH - 10, { align: 'center' });
      }
    }

    if (firstPage) {
      showToast('No results to export', 'error');
      return;
    }

    doc.save('exam_supervision_schedule.pdf');
    showToast('PDF downloaded!', 'success');
  };

  // ========== RESET ALL ==========
  const resetAll = async () => {
    if (!confirm('Perform dynamic hard reset?')) return;
    await fetch('/api/distribute', { method: 'DELETE' });
    loadAll();
    setResults(null);
    showToast('All data has been reset', 'info');
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
      <div className="app" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', zIndex: 1 }}>
        <style jsx>{`
          @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(1.4)} }
        `}</style>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 48, maxWidth: 400, width: '90%', textAlign: 'center' }}>
          <div style={{ width: 12, height: 12, background: 'var(--accent)', borderRadius: '50%', margin: '0 auto 16px', animation: 'pulse 2s infinite' }} />
          <h1 style={{ fontFamily: 'var(--mono)', fontSize: 16, color: 'var(--accent)', letterSpacing: 2, marginBottom: 8 }}>EXAM · SUPERVISOR</h1>
          <p style={{ color: 'var(--text2)', fontSize: 13, marginBottom: 32 }}>Exam Committee Distribution System</p>

          {!loginMode ? (
            /* Step 1: Choose role */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <button
                onClick={() => { setLoginMode('user'); setLoginError(''); setPassword(''); }}
                style={{ padding: '18px 24px', borderRadius: 12, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 16, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--sans)', transition: 'all 0.2s', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}
                onMouseOver={e => { (e.target as HTMLElement).style.borderColor = 'var(--accent)'; (e.target as HTMLElement).style.background = 'rgba(0,212,255,0.05)'; }}
                onMouseOut={e => { (e.target as HTMLElement).style.borderColor = 'var(--border)'; (e.target as HTMLElement).style.background = 'var(--surface2)'; }}
              >
                <span style={{ fontSize: 22 }}>👤</span> Enter as User
              </button>
              <button
                onClick={() => { setLoginMode('admin'); setLoginError(''); setPassword(''); }}
                style={{ padding: '18px 24px', borderRadius: 12, background: 'var(--accent2)', border: 'none', color: '#fff', fontSize: 16, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--sans)', transition: 'all 0.2s', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}
                onMouseOver={e => { (e.target as HTMLElement).style.background = '#e55a2b'; }}
                onMouseOut={e => { (e.target as HTMLElement).style.background = 'var(--accent2)'; }}
              >
                <span style={{ fontSize: 22 }}>🔐</span> Enter as Admin
              </button>
            </div>
          ) : (
            /* Step 2: Enter password for chosen role */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 4, color: 'var(--text2)', fontSize: 13 }}>
                <button onClick={() => { setLoginMode(null); setLoginError(''); setPassword(''); }} style={{ background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 16, padding: '0 4px', lineHeight: 1 }}>←</button>
                <span>{loginMode === 'user' ? '👤 User Login' : '🔐 Admin Login'}</span>
              </div>
              <input
                type="password"
                placeholder={loginMode === 'user' ? 'Enter User Password' : 'Enter Admin Password'}
                value={password}
                onChange={e => { setPassword(e.target.value); setLoginError(''); }}
                onKeyDown={e => e.key === 'Enter' && handleLogin(loginMode)}
                autoFocus
                style={{ padding: '14px 16px', borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 15, fontFamily: 'var(--sans)', outline: 'none', textAlign: 'center', width: '100%' }}
              />
              <button
                onClick={() => handleLogin(loginMode)}
                style={{
                  padding: '14px 24px', borderRadius: 10,
                  background: loginMode === 'admin' ? 'var(--accent2)' : 'var(--accent)',
                  border: loginMode === 'admin' ? 'none' : '1px solid var(--accent)',
                  color: loginMode === 'admin' ? '#fff' : 'var(--bg)',
                  fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--sans)',
                  transition: 'all 0.2s', width: '100%'
                }}
                onMouseOver={e => {
                  if (loginMode === 'admin') (e.target as HTMLElement).style.background = '#e55a2b';
                  else (e.target as HTMLElement).style.opacity = '0.85';
                }}
                onMouseOut={e => {
                  if (loginMode === 'admin') (e.target as HTMLElement).style.background = 'var(--accent2)';
                  else (e.target as HTMLElement).style.opacity = '1';
                }}
              >
                {loginMode === 'user' ? 'دخول' : 'دخول'}
              </button>
              {loginError && <p style={{ color: 'var(--danger)', fontSize: 12, margin: '-4px 0 0' }}>{loginError}</p>}
            </div>
          )}

          <div style={{ marginTop: 24, fontSize: 11, color: 'var(--text2)' }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: isConnected ? 'var(--success)' : 'var(--danger)', marginRight: 6 }} />
            {isConnected ? 'Connected' : 'Offline'}
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
        <div className="card-title">Teacher Registry</div>
        {(isAdmin || userCanEditTeachers) && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {isAdmin && <button className="btn btn-demo" onClick={generateDemoTeachers}>🧪 Generate 200 Mock Teachers</button>}
          {isAdmin && <button className="btn btn-ghost" onClick={importCSV}>📂 Import CSV</button>}
          <button className="btn btn-primary" onClick={() => { cancelEdit(); setShowAddTeacher(!showAddTeacher); }}>
            + Add New Teacher
          </button>
        </div>
        )}
      </div>

      {showAddTeacher && (
        <div style={{ background: 'var(--surface2)', borderRadius: 10, padding: 20, marginBottom: 20 }}>
          <div className="grid-3">
            <div className="form-group">
              <label className="form-label">Full Name</label>
              <input className="form-input" value={formName} onChange={e => setFormName(e.target.value)} placeholder="e.g. John Doe" />
            </div>
            <div className="form-group">
              <label className="form-label">Specialist Subject</label>
              <select className="form-select" value={formSubject} onChange={e => setFormSubject(e.target.value)}>
                <option value="">-- Choose Subject --</option>
                {SUBJECTS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Stage Assignment Notes</label>
              <input className="form-input" value={formNotes} onChange={e => setFormNotes(e.target.value)} placeholder="e.g. prep, sec, primary" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" onClick={saveTeacher}>✓ Save Teacher</button>
            <button className="btn btn-ghost" onClick={cancelEdit}>Cancel</button>
          </div>
        </div>
      )}

      <div id="teachers-stats" style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <span className="badge badge-green">Total Registered: {teachers.length}</span>
        {Object.entries(teachers.reduce((acc: Record<string,number>, t) => { acc[t.subject] = (acc[t.subject]||0)+1; return acc; }, {})).map(([s,c]) => (
          <span key={s} className="badge badge-blue">{s}: {c}</span>
        ))}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Index</th><th>Teacher Name</th><th>Subject Badge</th><th>Stage Rules</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {teachers.length === 0 ? (
              <tr><td colSpan={5} style={{ textAlign: 'center', padding: 32 }}>No teachers loaded in registry.</td></tr>
            ) : teachers.map((t, i) => (
              <tr key={t.id}>
                <td>{i + 1}</td>
                <td style={{ fontWeight: 600, color: 'var(--text)' }}>{t.name}</td>
                <td><span className="badge badge-blue">{t.subject}</span></td>
                <td style={{ color: 'var(--accent3)' }}>{t.notes || 'Any Stage'}</td>
                <td>
                  <button className="action-btn edit-btn" onClick={() => startEdit(t)}>✏️ Edit</button>
                  {isAdmin && <button className="action-btn del-btn" onClick={() => deleteTeacher(t.id)}>✕ Remove</button>}
                </td>
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
        <div className="card-title">Exam Structure Blueprint</div>
        {isAdmin && (
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" onClick={saveSchedule}>💾 Save Blueprint</button>
          <button className="btn btn-ghost" onClick={resetSchedule}>↺ Reset Matrix</button>
        </div>
        )}
      </div>
      <div className="table-wrap" style={{ maxHeight: '70vh', overflow: 'auto' }}>
        <div className="schedule-grid">
          <div className="sg-header">Grade Blueprint</div>
          {DAYS.map(d => <div key={d} className="sg-header">{d}</div>)}

          {GRADES.map(grade => (
            <React.Fragment key={grade}>
              <div className="sg-grade">{grade}</div>
              {DAYS.map(day => {
                const cell = getCell(grade, day);
                return (
                  <div key={day} className="sg-cell">
                    <input type="number" min="0" placeholder="Comms" value={cell.committees || ''} onChange={e => updateCell(grade, day, 'committees', parseInt(e.target.value) || 0)} readOnly={!isAdmin} style={!isAdmin ? { opacity: 0.7, cursor: 'not-allowed' } : {}} />
                    <select value={cell.subject || ''} onChange={e => updateCell(grade, day, 'subject', e.target.value)} disabled={!isAdmin} style={!isAdmin ? { opacity: 0.7, cursor: 'not-allowed' } : {}}>
                      <option value="">Subject</option>
                      {SUBJECTS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <input type="text" placeholder="Time Window" value={cell.time || ''} onChange={e => updateCell(grade, day, 'time', e.target.value)} readOnly={!isAdmin} style={!isAdmin ? { opacity: 0.7, cursor: 'not-allowed' } : {}} />
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
        <div className="stat-card"><span className="stat-number">{teachers.length}</span><div className="stat-label">Available Pools</div></div>
        <div className="stat-card"><span className="stat-number">{totalCommittees}</span><div className="stat-label">Active Rooms Matrix</div></div>
        <div className="stat-card"><span className="stat-number">{totalSlots}</span><div className="stat-label">Total Task Slots</div></div>
      </div>
      <div className="card">
        <div className="card-title" style={{ marginBottom: 16 }}>Distribution Engine Rules</div>
        <div className="grid-2">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" id="rule-subject" defaultChecked style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
              No teacher supervises their own subject
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" id="rule-daylimit" defaultChecked style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
              Max 1 duty per day (relaxed only if shortage)
            </label>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" id="rule-notes" defaultChecked style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
              Respect Stage Notes (primary/prep/sec)
            </label>
            <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.6, padding: '4px 0' }}>
              • Chronological day-by-day processing<br/>
              • MAX 1 committee per teacher per day (hard rule)<br/>
              • Admin participates normally (min 2 assignments)<br/>
              • Hours balanced from actual assignments (no bugs)<br/>
              • No same grade on consecutive days<br/>
              • No time overlap for same teacher
            </div>
          </div>
        </div>
      </div>
      <div className="distribute-btn-wrap">
        <button className="btn btn-orange" onClick={runDistribution}>
          ⚡ RUN ULTRA ANTI-OVERLAP BALANCER
        </button>
      </div>
    </>
  );

  // ========== RESULTS PAGE ==========
  const renderResultsPage = () => {
    if (!results?.assignments) return <div className="card"><div className="empty-state"><p>Execute the distribution engine to view results</p></div></div>;

    const STAGE_LABELS: Record<string, string> = { primary: 'ابتدائي', prep: 'اعدادي', sec: 'ثانوي' };
    const STAGE_COLORS: Record<string, string> = { primary: '#f59e0b', prep: '#8b5cf6', sec: '#06b6d4' };

    return (
      <div>
        <div style={{ marginBottom: 16, display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" onClick={exportPDF}>📄 Download PDF (A4 Printable)</button>
        </div>
        {DAYS.map(day => {
          const sessions = results.assignments[day] || [];
          const dayStandbys = results.standbys?.[day];
          const hasStandby = dayStandbys && Object.values(dayStandbys).some(s => s.length > 0);
          if (sessions.length === 0 && !hasStandby) return null;
          return (
            <div key={day} className="result-day">
              <div className="result-day-header" onClick={() => {
                const body = document.getElementById('day-body-' + day);
                if (body) body.style.display = body.style.display === 'none' ? 'block' : 'none';
              }}>
                <div className="result-day-title">📅 Day: {day} </div>
                <span>View Options ▼</span>
              </div>
              <div className="result-day-body" id={'day-body-' + day} style={{ display: 'block' }}>
                {sessions.map((session, si) => (
                  <div key={si} className="result-session">
                    <div className="result-session-header">
                      <span className="rs-grade">{session.grade}</span>
                      <span className="rs-time">⏰ Window: {session.time}</span>
                      <span className="rs-subject">📖 Subject: {session.subject || 'Unassigned'}</span>
                    </div>
                    <div className="result-com" style={{ background: 'var(--surface2)', fontSize: 12, fontWeight: 600 }}>
                      <div className="rc-cell rc-num">Room</div>
                      <div className="rc-cell">Lead Supervisor</div>
                      <div className="rc-cell">Associate Supervisor</div>
                      <div className="rc-cell" style={{ justifyContent: 'center' }}>Daily Load Check</div>
                    </div>
                    {session.committees.map((c, ci) => {
                      const dc1 = c.t1.id ? results.tracking[c.t1.id]?.dayComm[day] : 0;
                      const dc2 = c.t2.id ? results.tracking[c.t2.id]?.dayComm[day] : 0;
                      return (
                        <div key={ci} className="result-com">
                          <div className="rc-cell rc-num">Room {c.serial}</div>
                          <div className="rc-cell">{c.t1.name}</div>
                          <div className="rc-cell">{c.t2.name}</div>
                          <div className="rc-cell" style={{ justifyContent: 'center', fontFamily: 'var(--mono)', color: 'var(--text2)', fontSize: 11 }}>
                            {c.t1.id ? dc1 + ' Duty' : '-'} / {c.t2.id ? dc2 + ' Duty' : '-'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
                {/* Standby section */}
                {hasStandby && (
                  <div style={{ marginTop: 12, background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 10, padding: '12px 16px' }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#f59e0b', marginBottom: 8 }}>📍 المدرسين المتاحين (احتياطي)</div>
                    {['primary', 'prep', 'sec'].map(stage => {
                      const stList = dayStandbys?.[stage] || [];
                      if (stList.length === 0) return null;
                      return (
                        <div key={stage} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: STAGE_COLORS[stage], background: `${STAGE_COLORS[stage]}18`, padding: '2px 10px', borderRadius: 6 }}>{STAGE_LABELS[stage]}</span>
                          <span style={{ fontSize: 13, color: 'var(--text)' }}>
                            {stList.map((s, i) => <span key={s.id}>{i > 0 && ' , '}{s.name}</span>)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // ========== STATS PAGE (v6 — hours from assignments + standby) ==========
  const renderStatsPage = () => {
    if (!results?.assignments || teachers.length === 0) return <div className="card"><div className="empty-state"><p>No analytics to track.</p></div></div>;

    // ---- Calculate ALL stats from actual assignments (source of truth) ----
    const teacherStats: Record<string, {
      totalComm: number; totalHours: number;
      dayComm: Record<string, number>;
      assignedSlots: {day:string;start:number;end:number}[];
    }> = {};
    teachers.forEach(t => {
      teacherStats[t.id] = { totalComm: 0, totalHours: 0, dayComm: {} as Record<string,number>, assignedSlots: [] };
      DAYS.forEach(d => { teacherStats[t.id].dayComm[d] = 0; });
    });

    for (const day of DAYS) {
      const sessions = results.assignments[day] || [];
      for (const sess of sessions) {
        const ti = parseTimeRange(sess.time || '9:00-10:30');
        for (const c of sess.committees) {
          [c.t1, c.t2].forEach(who => {
            if (!who.id) return;
            const ts = teacherStats[who.id];
            if (!ts) return;
            ts.totalComm++;
            ts.dayComm[day] = (ts.dayComm[day] || 0) + 1;
            // Deduplicate hours: same day + same time range = counted once
            if (!ts.assignedSlots.some(s => s.day === day && s.start === ti.start && s.end === ti.end)) {
              ts.assignedSlots.push({ day, start: ti.start, end: ti.end });
              ts.totalHours += ti.duration;
            }
          });
        }
      }
    }

    // Count standby — informational only, no hours/committees added
    // (standby is displayed separately in results, not counted in stats)

    // ---- Aggregate statistics ----
    let totalComAll = 0, totalHrsAll = 0, notUsedCount = 0;
    const activeHours: number[] = [];
    teachers.forEach(t => {
      const ts = teacherStats[t.id];
      totalComAll += ts.totalComm;
      totalHrsAll += ts.totalHours;
      if (ts.totalComm === 0) notUsedCount++;
      if (ts.totalHours > 0) activeHours.push(ts.totalHours);
    });
    const maxHrs = Math.max(...teachers.map(t => teacherStats[t.id].totalHours));
    const minHrs = Math.min(...teachers.map(t => teacherStats[t.id].totalHours));
    // Average among teachers who actually got assignments (more meaningful)
    const avgHrs = activeHours.length > 0 ? activeHours.reduce((a, b) => a + b, 0) / activeHours.length : 0;
    const overAvgCount = teachers.filter(t => teacherStats[t.id].totalHours > avgHrs && teacherStats[t.id].totalHours > 0).length;
    const sorted = [...teachers].sort((a, b) => teacherStats[b.id].totalHours - teacherStats[a.id].totalHours);

    return (
      <>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12, marginBottom: 20 }}>
          <div className="stat-card"><span className="stat-number">{totalHrsAll.toFixed(1)}</span><div className="stat-label">Total Hours (All)</div></div>
          <div className="stat-card"><span className="stat-number">{avgHrs.toFixed(1)}</span><div className="stat-label">Avg Hours / Active</div></div>
          <div className="stat-card"><span className="stat-number">{maxHrs.toFixed(1)}</span><div className="stat-label">Max Hours</div></div>
          <div className="stat-card"><span className="stat-number" style={{ color: (maxHrs - minHrs) > 2 ? 'var(--danger)' : 'var(--accent3)' }}>{(maxHrs - minHrs).toFixed(1)}h</span><div className="stat-label">Max-Min Spread</div></div>
          <div className="stat-card"><span className="stat-number" style={{ color: overAvgCount > 0 ? 'var(--danger)' : 'var(--accent3)' }}>{overAvgCount}</span><div className="stat-label">Over Avg</div></div>
          <div className="stat-card"><span className="stat-number" style={{ color: 'var(--warning)' }}>{notUsedCount}</span><div className="stat-label">Not Assigned</div></div>
        </div>
        <div className="card">
          <div className="card-title" style={{ marginBottom: 16 }}>Teacher Load Summary</div>
          <div className="table-wrap" style={{ maxHeight: '70vh', overflow: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Teacher Name</th><th>Subject</th>
                  {DAYS.map(d => <th key={d}>{d.slice(0, 3)}</th>)}
                  <th style={{ background: 'rgba(0,212,255,0.1)' }}>Total<br/>Committees</th>
                  <th style={{ background: 'rgba(0,255,157,0.1)', minWidth: 100 }}>Total<br/>Hours</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((t, i) => {
                  const ts = teacherStats[t.id];
                  const hrs = ts.totalHours;
                  const pct = maxHrs > 0 ? Math.round(hrs / maxHrs * 100) : 0;
                  const isOverAvg = hrs > 0 && hrs > avgHrs;
                  const hrsColor = hrs === 0 ? 'var(--text2)' : isOverAvg ? 'var(--danger)' : 'var(--accent3)';
                  const status = hrs === 0
                    ? <span className="badge" style={{ background: 'rgba(255,68,68,0.1)', color: 'var(--danger)' }}>Not Used</span>
                    : isOverAvg
                      ? <span className="badge" style={{ background: 'rgba(255,68,68,0.15)', color: 'var(--danger)', fontWeight: 700 }}>Over Avg</span>
                      : <span className="badge" style={{ background: 'rgba(0,255,157,0.1)', color: 'var(--accent3)' }}>Balanced</span>;
                  return (
                    <tr key={t.id} style={isOverAvg ? { background: 'rgba(255,68,68,0.04)' } : {}}>
                      <td style={{ color: 'var(--text2)' }}>{i + 1}</td>
                      <td style={{ fontWeight: 600, color: 'var(--text)' }}>{t.name}</td>
                      <td><span className="badge badge-blue">{t.subject}</span></td>
                      {DAYS.map(d => {
                        const val = ts.dayComm[d] || 0;
                        const cellColor = val >= 2 ? 'var(--danger)' : val === 1 ? 'var(--accent3)' : 'var(--text2)';
                        return <td key={d} style={{ textAlign: 'center', fontWeight: 600, color: cellColor }}>{val || '-'}</td>;
                      })}
                      <td style={{ textAlign: 'center', fontWeight: 700, color: 'var(--accent)', fontFamily: 'var(--mono)' }}>{ts.totalComm}</td>
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
                  <td colSpan={3} style={{ color: 'var(--accent)', fontWeight: 700 }}>TOTAL</td>
                  {DAYS.map(d => {
                    const dayTotal = teachers.reduce((a, t) => a + teacherStats[t.id].dayComm[d], 0);
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
  const hasResults = !!(results?.assignments && results?.standbys && results?.tracking);
  const pages: { key: Page; label: string; adminOnly: boolean; requiresResults?: boolean }[] = [
    { key: 'teachers', label: '👨‍🏫 Teachers', adminOnly: false },
    { key: 'schedule', label: '📅 Schedule', adminOnly: false },
    { key: 'distribute', label: '⚡ Distribute', adminOnly: true },
    { key: 'results', label: '📋 Results', adminOnly: false },
    { key: 'stats', label: '📊 Statistics Load Ledger', adminOnly: false, requiresResults: true },
  ];

  const visiblePages = pages.filter(p => {
    if (p.adminOnly && !isAdmin) return false;
    if (p.requiresResults && !hasResults) return false;
    return true;
  });

  return (
    <div className="app">
      {/* Header */}
      <header>
        <div className="logo">
          <div className="logo-dot" />
          EXAM · SUPERVISOR · EQUALIZER · v10
        </div>
        <div className="header-actions">
          <span className="badge" style={{ background: `${roleColor}22`, color: roleColor }}>{roleLabel}</span>
          <span style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: isConnected ? 'var(--success)' : 'var(--danger)' }} />
            {isConnected ? 'Live' : 'Offline'}
          </span>
          <button className="btn btn-ghost" onClick={exportCSV}>📥 Export CSV</button>
          {isAdmin && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text2)' }}>
            <span>User Edit:</span>
            <button
              onClick={() => toggleUserEditPermission(!userCanEditTeachers)}
              style={{ width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', background: userCanEditTeachers ? 'var(--success)' : 'var(--border)' }}
            >
              <div style={{ width: 16, height: 16, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: userCanEditTeachers ? 18 : 2, transition: 'left 0.2s' }} />
            </button>
          </div>
          )}
          {isAdmin && <button className="btn btn-ghost" onClick={resetAll}>🗑 Reset All</button>}
          <button className="btn btn-ghost" onClick={handleLogout}>🚪 Logout</button>
        </div>
      </header>

      {/* Nav Tabs */}
      <div className="nav-tabs">
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
      <main className="main">
        {loading ? (
          <div style={{ textAlign: 'center', padding: 64, color: 'var(--text2)' }}>
            <div style={{ width: 24, height: 24, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 12px' }} />
            Loading...
          </div>
        ) : (
          <>
            {activePage === 'teachers' && renderTeachersPage()}
            {activePage === 'schedule' && renderSchedulePage()}
            {activePage === 'distribute' && renderDistributePage()}
            {activePage === 'results' && renderResultsPage()}
            {activePage === 'stats' && renderStatsPage()}
          </>
        )}
      </main>

      {/* Toast */}
      <div id="app-toast" className="toast" />
    </div>
  );
}