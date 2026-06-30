'use client';

export const dynamic = 'force-dynamic';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createClient, RealtimeChannel } from '@supabase/supabase-js';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

// ========== CONSTANTS ==========
const WEEK1_DAYS = ['W1-Saturday','W1-Sunday','W1-Monday','W1-Tuesday','W1-Wednesday','W1-Thursday'];
const WEEK2_DAYS = ['W2-Saturday','W2-Sunday','W2-Monday','W2-Tuesday','W2-Wednesday','W2-Thursday'];
const DAYS = [...WEEK1_DAYS, ...WEEK2_DAYS];
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
type Page = 'teachers' | 'schedule' | 'distribute' | 'results' | 'stats' | 'users' | 'log';
type LogView = 'admin' | 'users';

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
  const [userPermissions, setUserPermissions] = useState<string[]>([]);

  // Multi-user state
  const [supervisors, setSupervisors] = useState<{ id: string; name: string; permissions?: string[] }[]>([]);
  const [selectedSupervisor, setSelectedSupervisor] = useState('');
  const [currentUser, setCurrentUser] = useState('');
  const [auditLog, setAuditLog] = useState<{ id: string; timestamp: string; user: string; action: string; details: string }[]>([]);
  const [supFormName, setSupFormName] = useState('');
  const [supFormPass, setSupFormPass] = useState('');
  const [editingSupId, setEditingSupId] = useState<string | null>(null);
  const [supFormPermissions, setSupFormPermissions] = useState<string[]>([]);

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

  // Log sub-page state
  const [logView, setLogView] = useState<LogView>('admin');

  // Ref for Supabase realtime channels
  const channelsRef = useRef<RealtimeChannel[]>([]);

  // ========== HELPER: Log audit action ==========
  const logAudit = useCallback(async (action: string, details: string) => {
    if (!currentUser) return;
    try {
      fetch('/api/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: currentUser, action, details })
      });
    } catch { /* silent */ }
  }, [currentUser]);

  // ========== LOAD SUPERVISORS (for login dropdown) ==========
  const loadSupervisors = useCallback(async () => {
    try {
      const res = await fetch('/api/supervisors');
      if (res.ok) setSupervisors(await res.json());
    } catch { /* silent */ }
  }, []);

  // ========== LOAD AUDIT LOG ==========
  const loadAuditLog = useCallback(async () => {
    try {
      const res = await fetch('/api/audit');
      if (res.ok) setAuditLog(await res.json());
    } catch { /* silent */ }
  }, []);

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
          if (!d._version || d._version < 10) {
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
    try {
      const order = await loadSettings();
      await Promise.all([loadTeachers(order.length > 0 ? order : undefined), loadSchedule(), loadResults()]);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [loadTeachers, loadSchedule, loadResults, loadSettings]);

  // ========== INIT: Load supervisors on mount (for login dropdown) ==========
  useEffect(() => {
    loadSupervisors();
  }, [loadSupervisors]);

  // ========== INIT: Auto-login from session ==========
  useEffect(() => {
    const saved = sessionStorage.getItem('exam_auth');
    if (saved) {
      try {
        const { role, name, permissions } = JSON.parse(saved);
        setView(role);
        setCurrentUser(name || 'Admin');
        if (permissions) setUserPermissions(permissions);
        loadAll();
        if (role === 'admin') { loadSupervisors(); loadAuditLog(); }
        else { loadSupervisors(); }
      } catch { /* ignore bad session */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (role === 'user' && !selectedSupervisor) { setLoginError('Please select your name'); return; }
    if (!password.trim()) { setLoginError('Please enter the password'); return; }
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, role, name: role === 'user' ? selectedSupervisor : undefined })
      });
      const data = await res.json();
      if (data.success) {
        const userName = role === 'user' ? (data.name || selectedSupervisor) : 'Admin';
        const perms = data.permissions || [];
        setCurrentUser(userName);
        setView(data.role);
        setUserPermissions(perms);
        sessionStorage.setItem('exam_auth', JSON.stringify({ role: data.role, name: userName, permissions: perms }));
        loadAll();
        loadSettings();
        if (role === 'admin') { loadSupervisors(); loadAuditLog(); }
        else { loadSupervisors(); }
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
    setSelectedSupervisor('');
    setCurrentUser('');
    setTeachers([]);
    setSchedule([]);
    setResults(null);
    setUserCanEditTeachers(false);
    setUserPermissions([]);
  };

  // ========== TEACHER ACTIONS ==========

  const deleteTeacher = async (id: string) => {
    if (!isAdmin) { showToast('Delete is admin only', 'error'); return; }
    const tch = teachers.find(t => t.id === id);
    if (!confirm('Delete this teacher?')) return;
    try {
      await fetch(`/api/teachers?id=${id}`, { method: 'DELETE' });
      const newOrder = teacherOrder.filter(tid => tid !== id);
      setTeacherOrder(newOrder);
      saveTeacherOrder(newOrder);
      loadTeachers();
      logAudit('teacher_deleted', `Deleted: ${tch?.name || id} (${tch?.subject || ''})`);
      showToast('Teacher deleted', 'success');
    } catch { showToast('Error deleting', 'error'); }
  };

  const startEdit = (t: Teacher) => {
    if (!canEdit) { showToast('No edit permission - ask admin', 'error'); return; }
    setEditTeacherId(t.id);
    setFormName(t.name);
    setFormSubject(t.subject);
    setFormNotes(t.notes);
  };

  const inlineSave = async (id: string) => {
    if (!formName.trim() || !formSubject) { showToast('Please complete all fields', 'error'); return; }
    try {
      await fetch('/api/teachers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: formName.trim(), subject: formSubject, notes: formNotes.trim() })
      });
      logAudit('teacher_edited', `Edited: ${formName.trim()} (${formSubject})`);
      showToast('Teacher updated', 'success');
      setEditTeacherId(null);
      loadTeachers();
    } catch { showToast('Error saving teacher', 'error'); }
  };

  const saveTeacher = async () => {
    if (!formName.trim() || !formSubject) { showToast('Please complete all fields', 'error'); return; }
    if (!canEdit) { showToast('No permission - ask admin', 'error'); return; }
    try {
      if (editTeacherId) {
        await fetch('/api/teachers', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: editTeacherId, name: formName.trim(), subject: formSubject, notes: formNotes.trim() })
        });
        logAudit('teacher_edited', `Edited: ${formName.trim()} (${formSubject})`);
        showToast('Teacher updated', 'success');
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
        logAudit('teacher_added', `Added: ${formName.trim()} (${formSubject})`);
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

  const cancelAddForm = () => {
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
      logAudit('schedule_saved', 'Updated exam schedule blueprint');
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
      logAudit('schedule_reset', 'Cleared all schedule data');
    } catch { /* silent */ }
  };

  // ========== DISTRIBUTION ENGINE v4 ==========
  const runDistribution = () => {
    if (teachers.length === 0) { showToast('Error: Registry empty!', 'error'); return; }

    const ruleSubject = (document.getElementById('rule-subject') as HTMLInputElement)?.checked ?? true;
    const ruleDayLimit = (document.getElementById('rule-daylimit') as HTMLInputElement)?.checked ?? true;
    const ruleNotes = (document.getElementById('rule-notes') as HTMLInputElement)?.checked ?? true;
    const includeAdminW2 = (document.getElementById('rule-admin-w2') as HTMLInputElement)?.checked ?? false;

    // ---- Admin handling: Admin subject excluded by default, included only for W2 peak days ----

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

    // ---- Helper: Special subject pairing rules ----
    // Religion exam: Arabic + Religion teachers blocked
    // Arabic exam: Religion teachers blocked from primary only
    const isBlockedBySpecialRule = (teacher: Teacher, slot: Slot): boolean => {
      if (slot.subject === 'Religion' && (teacher.subject === 'Arabic' || teacher.subject === 'Religion')) return true;
      if (slot.subject === 'Arabic' && teacher.subject === 'Religion' && slot.stage === 'primary') return true;
      return false;
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

    // ---- Helper: Special subject exclusion rules (Religion/Arabic) ----
    // Rule 1: If exam subject is Religion (الدين), teachers with subject Arabic (العربي) are excluded (Religion teachers already caught by own-subject)
    // Rule 2: If exam subject is Arabic (العربي), teachers with subject Religion (الدين) are excluded for primary stage only
    const isSubjectExcluded = (t: Teacher, slot: Slot): boolean => {
      if (!ruleSubject || !slot.subject) return false;
      if (slot.subject === 'الدين') {
        return t.subject === 'العربي';
      }
      if (slot.subject === 'العربي' && slot.stage === 'primary') {
        return t.subject === 'الدين';
      }
      return false;
    };

    // ---- Core: Find best teacher for a slot ----
    // HARD RULES: own-subject, stage notes, NO same-day double, time overlap
    // Scoring: hours dominate (500x), tiny noise (0.1) for variety
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
        // HARD: Special subject exclusion (Religion/Arabic rules)
        if (isSubjectExcluded(t, slot)) continue;
        // HARD: Stage notes filtering
        if (!canSuperviseStage(t, slot.stage)) continue;
        // HARD: No time overlap on same day
        if (tr.assignedSlots.some(s => s.day === slot.day && !(slot.timeInfo.end <= s.start || slot.timeInfo.start >= s.end))) continue;
        // HARD: MAX 2 committees per teacher per day (NEVER relaxed)
        if (ruleDayLimit && tr.dayComm[slot.day] >= 2) continue;
        // SOFT: No same grade on consecutive days (can be relaxed)
        if (!relaxAdj && wasSameGradeAdjacent(tr, slot)) continue;
        // Scoring: HOURS dominate (500x), then committees (10x), tiny noise for variety
        // Admin subject = HEAVY penalty (always last choice)
        const isAdmin = t.subject === 'Admin';
        const adminPenalty = isAdmin ? 50000 : 0;
        const score = tr.totalHours * 500 + tr.totalComm * 10 + adminPenalty + Math.random() * 0.1;
        candidates.push({ teacher: t, score });
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => a.score - b.score);
      const best = candidates[0].score;
      const topGroup = candidates.filter(c => c.score <= best + 0.5);
      return topGroup[Math.floor(Math.random() * topGroup.length)].teacher;
    };

    // ---- Fallback 2: Relax stage constraints only (keep own-subject, 2-per-day + time) ----
    const findBestRelaxed = (blockedId: string | null, slot: Slot, pool: Teacher[]): Teacher | null => {
      const candidates: { teacher: Teacher; score: number }[] = [];
      for (const t of pool) {
        if (blockedId && t.id === blockedId) continue;
        const tr = tracking[t.id];
        // HARD: Still no own-subject supervision even in relaxed mode
        if (ruleSubject && slot.subject && t.subject === slot.subject) continue;
        // HARD: Special subject exclusion (Religion/Arabic rules) — never relaxed
        if (isSubjectExcluded(t, slot)) continue;
        if (tr.assignedSlots.some(s => s.day === slot.day && !(slot.timeInfo.end <= s.start || slot.timeInfo.start >= s.end))) continue;
        if (ruleDayLimit && tr.dayComm[slot.day] >= 2) continue;
        const isAdmin = t.subject === 'Admin';
        const adminPenalty = isAdmin ? 50000 : 0;
        const score = tr.totalHours * 500 + tr.totalComm * 10 + adminPenalty + Math.random() * 0.1;
        candidates.push({ teacher: t, score });
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => a.score - b.score);
      return candidates[0].teacher;
    };

    // ---- Fallback 3: Allow 2nd assignment same day (time overlap + own-subject + max 2/day blocked) ----
    const findBestForceDay = (blockedId: string | null, slot: Slot, pool: Teacher[]): Teacher | null => {
      const candidates: { teacher: Teacher; score: number }[] = [];
      for (const t of pool) {
        if (blockedId && t.id === blockedId) continue;
        const tr = tracking[t.id];
        // HARD: Still no own-subject supervision even in force-day mode
        if (ruleSubject && slot.subject && t.subject === slot.subject) continue;
        // HARD: Special subject exclusion (Religion/Arabic rules) — never relaxed
        if (isSubjectExcluded(t, slot)) continue;
        if (tr.assignedSlots.some(s => s.day === slot.day && !(slot.timeInfo.end <= s.start || slot.timeInfo.start >= s.end))) continue;
        // HARD: ABSOLUTE MAX 2 committees per teacher per day (never exceeded)
        if (ruleDayLimit && tr.dayComm[slot.day] >= 2) continue;
        const isAdmin = t.subject === 'Admin';
        const adminPenalty = isAdmin ? 50000 : 0;
        const score = tr.totalHours * 500 + tr.totalComm * 10 + (tr.dayComm[slot.day] || 0) * 100 + adminPenalty + Math.random() * 0.1;
        candidates.push({ teacher: t, score });
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => a.score - b.score);
      return candidates[0].teacher;
    };

    // ---- Process each day chronologically, shuffle slots within day for variety ----
    let standbyCount = 0;

    // ---- 'Old' teacher handling: senior teachers excluded from default pool, used as last resort ----
    const isOldTeacher = (t: Teacher) => !!(t.notes && t.notes.toLowerCase().includes('old'));
    const oldTeachers = teachers.filter(t => t.subject !== 'Admin' && isOldTeacher(t));
    const nonAdminTeachers = teachers.filter(t => t.subject !== 'Admin' && !isOldTeacher(t));

    // Track old teacher supervision days (max 3, min 1)
    const oldTeacherDays: Record<string, number> = {};
    oldTeachers.forEach(t => { oldTeacherDays[t.id] = 0; });

    // Calculate Week 2 peak days (days with above-average committee count)
    const w2SlotCounts = WEEK2_DAYS.map(d => slotsByDay[d].length).filter(c => c > 0);
    const w2Avg = w2SlotCounts.length > 0 ? w2SlotCounts.reduce((a, b) => a + b, 0) / w2SlotCounts.length : 0;
    const peakW2Days = new Set(WEEK2_DAYS.filter(d => slotsByDay[d].length >= w2Avg && slotsByDay[d].length > 0));

    for (const day of DAYS) {
      // Determine pool: Admin only included on W2 peak days when toggle is ON
      const isW2Peak = WEEK2_DAYS.includes(day) && peakW2Days.has(day);
      const dayPool = (includeAdminW2 && isW2Peak) ? [...teachers] : nonAdminTeachers;
      const daySlots = shuffle(slotsByDay[day]);
      if (daySlots.length === 0) continue;

      for (const slot of daySlots) {
        let t1: Teacher | null = null;
        let t2: Teacher | null = null;

        // Helper: filter old teachers not exceeding 3-day max and not already assigned today
        const availableOldTeachers = (blockedId: string | null, day: string) => {
          return oldTeachers.filter(ot => {
            if (blockedId && ot.id === blockedId) return false;
            if ((oldTeacherDays[ot.id] || 0) >= 3) return false;
            const tr = tracking[ot.id];
            if (tr.assignedSlots.some(s => s.day === day && !(slot.timeInfo.end <= s.start || slot.timeInfo.start >= s.end))) return false;
            return true;
          });
        };

        // T1: strict → relax consecutive → relax subject+stage → allow 2nd same-day → OLD teacher last resort
        t1 = findBest(null, slot, dayPool, false);
        if (!t1) t1 = findBest(null, slot, dayPool, true); // relax consecutive-day
        if (!t1) t1 = findBestRelaxed(null, slot, dayPool); // relax subject + stage
        if (!t1) t1 = findBestForceDay(null, slot, dayPool); // allow 2nd assignment same day
        // Last resort: try old teachers (max 3 days)
        if (!t1) t1 = findBest(null, slot, availableOldTeachers(null, slot.day), false);
        if (!t1) t1 = findBestRelaxed(null, slot, availableOldTeachers(null, slot.day));

        if (t1) {
          const tr = tracking[t1.id];
          tr.totalComm++; tr.dayComm[slot.day]++;
          tr.assignedSlots.push({ day: slot.day, start: slot.timeInfo.start, end: slot.timeInfo.end });
          tr.gradeHistory.push({ dayIndex: slot.dayIndex, grade: slot.grade });
          // Track old teacher days
          if (isOldTeacher(t1) && !tr.assignedSlots.some((s, idx) => idx < tr.assignedSlots.length - 1 && s.day === slot.day)) {
            oldTeacherDays[t1.id] = (oldTeacherDays[t1.id] || 0) + 1;
          }
        } else { standbyCount++; }

        // T2: pairing rule — classified teacher (has notes) must pair with unclassified
        const blocked = t1?.id || null;
        const t1Classified = t1 ? !!(t1.notes && t1.notes.trim() !== '') : false;
        const t2Filtered = t1Classified ? dayPool.filter(t => t.id !== blocked && (!t.notes || t.notes.trim() === '')) : dayPool;

        t2 = findBest(blocked, slot, t2Filtered, false);
        if (!t2) t2 = findBest(blocked, slot, t2Filtered, true);
        if (!t2) t2 = findBestRelaxed(blocked, slot, t2Filtered);
        if (!t2) t2 = findBestForceDay(blocked, slot, t2Filtered);
        // Relax pairing rule if no unclassified teacher available
        if (!t2 && t1Classified) {
          t2 = findBest(blocked, slot, dayPool, false);
          if (!t2) t2 = findBest(blocked, slot, dayPool, true);
          if (!t2) t2 = findBestRelaxed(blocked, slot, dayPool);
          if (!t2) t2 = findBestForceDay(blocked, slot, dayPool);
        }
        // Last resort: try old teachers for T2
        if (!t2) {
          const oldPool = availableOldTeachers(blocked, slot.day);
          t2 = findBest(blocked, slot, oldPool, false);
          if (!t2) t2 = findBestRelaxed(blocked, slot, oldPool);
        }

        if (t2) {
          const tr = tracking[t2.id];
          tr.totalComm++; tr.dayComm[slot.day]++;
          tr.assignedSlots.push({ day: slot.day, start: slot.timeInfo.start, end: slot.timeInfo.end });
          tr.gradeHistory.push({ dayIndex: slot.dayIndex, grade: slot.grade });
          // Track old teacher days
          if (isOldTeacher(t2) && !tr.assignedSlots.some((s, idx) => idx < tr.assignedSlots.length - 1 && s.day === slot.day)) {
            oldTeacherDays[t2.id] = (oldTeacherDays[t2.id] || 0) + 1;
          }
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

    // ---- Post-distribution: Admin already handled by pool exclusion ----

    // ---- Post-distribution: BALANCE PASS ----
    // Iteratively swap assignments from overburdened → underburdened teachers
    // to minimize the max-min spread in BOTH hours (primary) and committees (secondary)
    const BALANCE_ITERATIONS = 500;
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
      // Sort by HOURS first (primary), then committees (secondary)
      const sorted = [...active].sort((a, b) => {
        const hDiff = tracking[b.id].totalHours - tracking[a.id].totalHours;
        if (Math.abs(hDiff) > 0.1) return hDiff;
        return tracking[b.id].totalComm - tracking[a.id].totalComm;
      });
      const maxH = tracking[sorted[0].id].totalHours;
      const minH = tracking[sorted[sorted.length - 1].id].totalHours;
      if (maxH - minH <= 0.5) break; // spread ≤ 0.5h — tight balance

      let swapped = false;
      // Try top-5 donors × bottom-5 recipients for wider swap search
      for (let di = 0; di < Math.min(sorted.length, 5) && !swapped; di++) {
        const donor = sorted[di];
        // Don't strip admins below 1 assignment in balance pass
        // Never swap OUT old teachers (they are last-resort only)
        if (tracking[donor.id].totalComm <= 1) continue;
        if (isOldTeacher(donor)) continue;

        for (let ri = sorted.length - 1; ri >= Math.max(0, sorted.length - 5) && !swapped; ri--) {
          const recip = sorted[ri];
          if (donor.id === recip.id) continue;
          // NEVER give admin more assignments during balance pass
          // Old teachers CAN be recipients (swapped IN) but check their day limit
          if (recip.subject === 'Admin') continue;
          if (isOldTeacher(recip) && (oldTeacherDays[recip.id] || 0) >= 3) continue;
          if (tracking[donor.id].totalHours <= tracking[recip.id].totalHours + 0.3) continue;
            // Also check if committees would be more balanced after swap
            const donorCommAfter = tracking[donor.id].totalComm - 1;
            const recipCommAfter = tracking[recip.id].totalComm + 1;
            // Skip if swap would make committee imbalance worse (donor already has fewer comms)

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
              if (isSubjectExcluded(recip, { day, dayIndex: DAYS.indexOf(day), grade: sess.grade, stage: getStage(sess.grade), subject: sess.subject, time: sess.time, timeInfo: sessTI, comId: 0 })) continue;
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

                // Track old teacher day if recipient is old
                if (isOldTeacher(recip)) {
                  oldTeacherDays[recip.id] = (oldTeacherDays[recip.id] || 0) + 1;
                }

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

      // Determine pool for standby (same logic as distribution)
      const isW2Peak = WEEK2_DAYS.includes(day) && peakW2Days.has(day);
      const dayStandbyPool = (includeAdminW2 && isW2Peak) ? [...teachers] : nonAdminTeachers;

      for (const stage of STAGES_LIST) {
        // Only assign standby if there are exams for this stage on this day
        const stageSessions = (finalAssignments[day] || []).filter(s => getStage(s.grade) === stage);
        if (stageSessions.length === 0) continue;

        // Collect subjects being examined today for this stage
        const dayStageSubjects = new Set<string>();
        stageSessions.forEach(s => { if (s.subject) dayStageSubjects.add(s.subject); });

        // Find teachers NOT assigned on this day who can supervise this stage
        // AND whose subject doesn't match any exam subject for this stage today
        let candidates = dayStandbyPool.filter(t => {
          if ((tracking[t.id].dayComm[day] || 0) >= 2) return false;
          if (todayStandby[day].has(t.id)) return false; // already standby for another stage today
          if (!canSuperviseStage(t, stage)) return false;
          // CRITICAL: Don't pick a teacher whose subject is being examined today
          if (ruleSubject && t.subject && dayStageSubjects.has(t.subject)) return false;
          // CRITICAL: Special subject exclusion (Religion/Arabic) for standby
          if (ruleSubject && dayStageSubjects.has('الدين') && (t.subject === 'الدين' || t.subject === 'العربي')) return false;
          if (ruleSubject && dayStageSubjects.has('العربي') && t.subject === 'الدين' && stage === 'primary') return false;
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
    // V-Check 3: More than 2 same-day assignments (HARD RULE)
    for (const t of teachers) {
      const tr = tracking[t.id];
      for (const day of DAYS) {
        if ((tr.dayComm[day] || 0) > 2) {
          violations.push(`${t.name} -> 3+ committees on ${day} (HARD RULE VIOLATED)`);
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

    // V-Check 5: Pairing rule — two classified teachers in same committee
    for (const day of DAYS) {
      for (const sess of finalAssignments[day]) {
        for (const c of sess.committees) {
          if (c.t1.id && c.t2.id) {
            const t1Info = teachers.find(x => x.id === c.t1.id);
            const t2Info = teachers.find(x => x.id === c.t2.id);
            const t1Has = t1Info && t1Info.notes && t1Info.notes.trim() !== '';
            const t2Has = t2Info && t2Info.notes && t2Info.notes.trim() !== '';
            if (t1Has && t2Has) {
              violations.push(`${t1Info?.name} + ${t2Info?.name} -> both classified on ${day} (${sess.grade})`);
            }
          }
        }
      }
    }

    // V-Check 6: Special subject exclusion (Religion/Arabic rules)
    for (const day of DAYS) {
      for (const sess of finalAssignments[day]) {
        const sessStage = getStage(sess.grade);
        for (const c of sess.committees) {
          [c.t1, c.t2].forEach(who => {
            if (!who.id) return;
            const tch = teachers.find(x => x.id === who.id);
            if (!tch) return;
            if (sess.subject === 'الدين' && (tch.subject === 'العربي' || tch.subject === 'الدين')) {
              violations.push(`${tch.name} -> excluded subject for Religion exam on ${day}`);
            }
            if (sess.subject === 'العربي' && tch.subject === 'الدين' && sessStage === 'primary') {
              violations.push(`${tch.name} -> Religion excluded from primary Arabic exam on ${day}`);
            }
          });
        }
      }
    }

    // V-Check 7: Old teacher day count must be between 1-3
    for (const ot of oldTeachers) {
      const days = oldTeacherDays[ot.id] || 0;
      if (days > 3) {
        violations.push(`${ot.name} -> old teacher assigned ${days} days (max 3)`);
      }
    }

    // ---- Build summary statistics (from verified tracking) ----
    const allH = teachers.map(t => tracking[t.id]?.totalHours || 0);
    const avgAll = allH.length ? allH.reduce((a, b) => a + b, 0) / allH.length : 0;
    const spread = allH.length ? Math.sqrt(allH.reduce((s, h) => s + (h - avgAll) ** 2, 0) / allH.length) : 0;
    let msg = `v10 | Avg: ${avgAll.toFixed(1)}h | Spread: ${spread.toFixed(1)} | Min: ${allH.length ? Math.min(...allH).toFixed(1) : 0}h | Max: ${allH.length ? Math.max(...allH).toFixed(1) : 0}h`;
    // Count total standby assigned
    const totalStandby = Object.values(standbys).reduce((a, daySt) => a + Object.values(daySt).reduce((b, stList) => b + stList.length, 0), 0);
    if (totalStandby > 0) msg += ` | ${totalStandby} standby (${STANDBY_PER_STAGE}/stage/day)`;
    if (standbyCount > 0) msg += ` | ${standbyCount} unfilled`;
    if (violations.length > 0) {
      msg += ` | ${violations.length} violations (check console)`;
      console.warn('[Distribution v10] Violations:', violations);
    } else {
      console.log('[Distribution v10] All constraints passed!');
    }

    const newResults: DistributionResults = { _version: 10, assignments: finalAssignments, standbys, tracking };
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
      const displayDay = day.replace('W1-','Week 1 - ').replace('W2-','Week 2 - ');
      const sessions = results.assignments[day] || [];
      sessions.forEach(s => {
        s.committees.forEach(c => {
          csv += `"${displayDay}","${s.grade}","${s.time}","${s.subject || ''}","Room ${c.serial}","${c.t1.name}","${c.t2.name}","Primary"\n`;
        });
      });
      if (results.standbys?.[day]) {
        const STAGE_CSV: Record<string, string> = { primary: 'Primary', prep: 'Prep', sec: 'Secondary' };
        for (const stage of ['primary', 'prep', 'sec']) {
          for (const s of (results.standbys[day][stage] || [])) {
            csv += `"${displayDay}","${STAGE_CSV[stage]}","","","Standby","${s.name}","","Standby"\n`;
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

  // ========== EXPORT PDF (Arabic table, A4 per grade per day) ==========
  const exportPDF = async () => {
    if (!results?.assignments) return;

    const DAY_AR: Record<string, string> = {
      'W1-Saturday': 'السبت', 'W1-Sunday': 'الأحد', 'W1-Monday': 'الاثنين',
      'W1-Tuesday': 'الثلاثاء', 'W1-Wednesday': 'الأربعاء', 'W1-Thursday': 'الخميس',
      'W2-Saturday': 'السبت', 'W2-Sunday': 'الأحد', 'W2-Monday': 'الاثنين',
      'W2-Tuesday': 'الثلاثاء', 'W2-Wednesday': 'الأربعاء', 'W2-Thursday': 'الخميس',
    };
    const WEEK_AR: Record<string, string> = { 'W1': 'الأسبوع الأول', 'W2': 'الأسبوع الثاني' };
    const GRADE_AR: Record<string, string> = {
      'Grade 3 Primary': 'الصف الثالث الابتدائي',
      'Grade 4 Primary': 'الصف الرابع الابتدائي',
      'Grade 5 Primary': 'الصف الخامس الابتدائي',
      'Grade 6 Primary': 'الصف السادس الابتدائي',
      'Grade 1 Prep': 'الصف الأول الإعدادي',
      'Grade 2 Prep': 'الصف الثاني الإعدادي',
      'Grade 1 Secondary': 'الصف الأول الثانوي',
      'Grade 2 Secondary': 'الصف الثاني الثانوي',
    };
    const STAGE_AR: Record<string, string> = {
      primary: 'المرحلة الابتدائية', prep: 'المرحلة الإعدادية', sec: 'المرحلة الثانوية',
    };

    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = 210, pageH = 297;
    let firstPage = true;
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;top:-9999px;left:0;width:794px;z-index:-1;direction:rtl;font-family:"Segoe UI",Tahoma,Arial,sans-serif;color:#000;background:#fff;';

    const pages: HTMLDivElement[] = [];

    for (const day of DAYS) {
      const sessions = results.assignments[day] || [];
      const dayStandbys = results.standbys?.[day];
      const hasDayStandby = dayStandbys && Object.values(dayStandbys).some(s => s.length > 0);
      if (sessions.length === 0 && !hasDayStandby) continue;

      const weekKey = day.startsWith('W1') ? 'W1' : 'W2';
      const dayAr = DAY_AR[day] || day;
      const weekAr = WEEK_AR[weekKey] || '';

      for (const session of sessions) {
        if (session.committees.length === 0) continue;

        const pageDiv = document.createElement('div');
        pageDiv.style.cssText = 'width:794px;padding:40px 50px;box-sizing:border-box;background:#fff;page-break-after:always;';

        // Header / Decoration
        const headerHtml = `
          <div style="text-align:center;margin-bottom:20px;">
            <div style="font-size:22px;font-weight:bold;color:#1e3a5f;border-bottom:3px double #1e3a5f;padding-bottom:8px;display:inline-block;">
              جدول إشراف الامتحانات
            </div>
          </div>
          <div style="display:flex;flex-wrap:wrap;justify-content:space-between;font-size:15px;margin-bottom:18px;padding:10px 16px;background:#f0f4f8;border-radius:8px;border:1px solid #d0d8e0;direction:rtl;">
            <div style="font-weight:bold;"><span style="color:#555;">اليوم:</span> ${dayAr} (${weekAr})</div>
            <div style="font-weight:bold;"><span style="color:#555;">الصف:</span> ${GRADE_AR[session.grade] || session.grade}</div>
            <div style="font-weight:bold;"><span style="color:#555;">المادة:</span> ${session.subject || '—'}</div>
            <div style="font-weight:bold;"><span style="color:#555;">التوقيت:</span> ${session.time}</div>
          </div>
        `;

        // Table: each row = one committee, split into 2 supervisors + signatures
        const rowsHtml = session.committees.map(c => `
          <tr>
            <td style="border:1px solid #333;padding:10px 8px;text-align:center;width:55px;font-weight:bold;font-size:14px;">${c.serial}</td>
            <td style="border:1px solid #333;padding:10px 12px;text-align:center;width:230px;font-size:15px;">${c.t1.name}</td>
            <td style="border:1px solid #333;padding:10px 8px;text-align:center;width:80px;"></td>
            <td style="border:1px solid #333;padding:10px 12px;text-align:center;width:230px;font-size:15px;">${c.t2.name}</td>
            <td style="border:1px solid #333;padding:10px 8px;text-align:center;width:80px;"></td>
          </tr>
        `).join('');

        const tableHtml = `
          <table style="width:100%;border-collapse:collapse;margin-top:10px;">
            <thead>
              <tr style="background:#1e3a5f;color:#fff;">
                <th style="border:1px solid #333;padding:10px 8px;text-align:center;width:55px;font-size:14px;">م</th>
                <th style="border:1px solid #333;padding:10px 12px;text-align:center;width:230px;font-size:14px;">اسم المراقب</th>
                <th style="border:1px solid #333;padding:10px 8px;text-align:center;width:80px;font-size:14px;">التوقيع</th>
                <th style="border:1px solid #333;padding:10px 12px;text-align:center;width:230px;font-size:14px;">اسم المراقب</th>
                <th style="border:1px solid #333;padding:10px 8px;text-align:center;width:80px;font-size:14px;">التوقيع</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        `;

        pageDiv.innerHTML = headerHtml + tableHtml;
        pages.push(pageDiv);
        container.appendChild(pageDiv);
      }

      // Standby page
      if (hasDayStandby) {
        const pageDiv = document.createElement('div');
        pageDiv.style.cssText = 'width:794px;padding:40px 50px;box-sizing:border-box;background:#fff;page-break-after:always;';

        const stList: { stage: string; name: string }[] = [];
        for (const stage of ['primary', 'prep', 'sec']) {
          const list = dayStandbys[stage] || [];
          list.forEach(s => stList.push({ stage: STAGE_AR[stage], name: s.name }));
        }

        if (stList.length > 0) {
          const headerHtml = `
            <div style="text-align:center;margin-bottom:20px;">
              <div style="font-size:22px;font-weight:bold;color:#b47814;border-bottom:3px double #b47814;padding-bottom:8px;display:inline-block;">
                المدرسين المتاحين (احتياطي)
              </div>
            </div>
            <div style="font-size:15px;margin-bottom:18px;padding:10px 16px;background:#fffbeb;border-radius:8px;border:1px solid #fde68a;direction:rtl;">
              <span style="font-weight:bold;color:#555;">اليوم:</span> <strong>${dayAr} (${weekAr})</strong>
            </div>
          `;

          const rowsHtml = stList.map((s, i) => `
            <tr>
              <td style="border:1px solid #333;padding:8px 12px;text-align:center;width:55px;font-weight:bold;font-size:14px;">${i + 1}</td>
              <td style="border:1px solid #333;padding:8px 12px;text-align:center;width:260px;font-size:15px;">${s.name}</td>
              <td style="border:1px solid #333;padding:8px 12px;text-align:center;width:80px;"></td>
              <td style="border:1px solid #333;padding:8px 12px;text-align:center;width:220px;font-size:13px;color:#555;">${s.stage}</td>
              <td style="border:1px solid #333;padding:8px 12px;text-align:center;width:80px;"></td>
            </tr>
          `).join('');

          const tableHtml = `
            <table style="width:100%;border-collapse:collapse;margin-top:10px;">
              <thead>
                <tr style="background:#b47814;color:#fff;">
                  <th style="border:1px solid #333;padding:10px 8px;text-align:center;width:55px;font-size:14px;">م</th>
                  <th style="border:1px solid #333;padding:10px 12px;text-align:center;width:260px;font-size:14px;">اسم المراقب</th>
                  <th style="border:1px solid #333;padding:10px 8px;text-align:center;width:80px;font-size:14px;">التوقيع</th>
                  <th style="border:1px solid #333;padding:10px 12px;text-align:center;width:220px;font-size:14px;">المرحلة</th>
                  <th style="border:1px solid #333;padding:10px 8px;text-align:center;width:80px;font-size:14px;">التوقيع</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          `;

          pageDiv.innerHTML = headerHtml + tableHtml;
          pages.push(pageDiv);
          container.appendChild(pageDiv);
        }
      }
    }

    if (pages.length === 0) {
      showToast('No results to export', 'error');
      document.body.removeChild(container);
      return;
    }

    document.body.appendChild(container);

    try {
      for (let i = 0; i < pages.length; i++) {
        const canvas = await html2canvas(pages[i], {
          scale: 2,
          useCORS: true,
          backgroundColor: '#ffffff',
          width: 794,
          windowWidth: 794,
        });
        const imgData = canvas.toDataURL('image/png');
        if (!firstPage) doc.addPage();
        firstPage = false;
        const imgW = pageW;
        const imgH = (canvas.height * imgW) / canvas.width;
        doc.addImage(imgData, 'PNG', 0, 0, imgW, Math.min(imgH, pageH));
      }
      doc.save('exam_supervision_schedule.pdf');
      showToast('PDF downloaded successfully!', 'success');
    } catch (err) {
      console.error('PDF export error:', err);
      showToast('Error exporting PDF', 'error');
    } finally {
      document.body.removeChild(container);
    }
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
            /* Step 2: Enter credentials for chosen role */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 4, color: 'var(--text2)', fontSize: 13 }}>
                <button onClick={() => { setLoginMode(null); setLoginError(''); setPassword(''); setSelectedSupervisor(''); }} style={{ background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 16, padding: '0 4px', lineHeight: 1 }}>←</button>
                <span>{loginMode === 'user' ? '👤 User Login' : '🔐 Admin Login'}</span>
              </div>
              {loginMode === 'user' && (
                <select
                  value={selectedSupervisor}
                  onChange={e => { setSelectedSupervisor(e.target.value); setLoginError(''); }}
                  style={{ padding: '14px 16px', borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)', color: selectedSupervisor ? 'var(--text)' : 'var(--text2)', fontSize: 15, fontFamily: 'var(--sans)', outline: 'none', width: '100%', cursor: 'pointer', appearance: 'auto' }}
                >
                  <option value="">-- Select your name --</option>
                  {supervisors.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                </select>
              )}
              <input
                type="password"
                placeholder={loginMode === 'user' ? 'Enter Password' : 'Enter Admin Password'}
                value={password}
                onChange={e => { setPassword(e.target.value); setLoginError(''); }}
                onKeyDown={e => e.key === 'Enter' && handleLogin(loginMode)}
                autoFocus={loginMode === 'admin'}
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
                Login
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
  const canEdit = isAdmin || userPermissions.includes('teachers') || userPermissions.includes('schedule') || userPermissions.includes('schedule_edit');
  const roleLabel = isAdmin ? 'ADMIN' : currentUser || 'USER';
  const roleColor = isAdmin ? 'var(--accent2)' : 'var(--accent3)';

  // ========== PERMISSIONS: Page access control ==========
  const canAccessPage = (page: Page): boolean => {
    if (page === 'distribute' || page === 'log') return isAdmin; // Always admin-only
    if (isAdmin) return true; // Admin sees all
    // schedule_edit grants same page visibility as schedule
    if (page === 'schedule' && userPermissions.includes('schedule_edit')) return true;
    // Regular user: default access to teachers (view), results, stats
    if (!userPermissions || userPermissions.length === 0) {
      return page === 'teachers' || page === 'results' || page === 'stats';
    }
    // User with specific permissions: only those pages
    return userPermissions.includes(page);
  };

  // ========== TEACHERS PAGE ==========
  const renderTeachersPage = () => (
    <div className="card">
      <div className="card-header">
        <div className="card-title">Teacher Registry</div>
        {(isAdmin || canEdit) && (
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
            <button className="btn btn-ghost" onClick={cancelAddForm}>Cancel</button>
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
            ) : teachers.map((t, i) => {
              if (editTeacherId === t.id) return (
                <tr key={t.id} style={{ background: 'rgba(0,212,255,0.06)' }}>
                  <td style={{ fontWeight: 700, color: 'var(--accent)' }}>{i + 1}</td>
                  <td><input className="form-input" value={formName} onChange={e => setFormName(e.target.value)} style={{ margin: 0, padding: '6px 10px', fontSize: 13 }} autoFocus /></td>
                  <td>
                    <select className="form-select" value={formSubject} onChange={e => setFormSubject(e.target.value)} style={{ margin: 0, padding: '6px 8px', fontSize: 13 }}>
                      <option value="">-- Subject --</option>
                      {SUBJECTS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </td>
                  <td><input className="form-input" value={formNotes} onChange={e => setFormNotes(e.target.value)} placeholder="Stage notes" style={{ margin: 0, padding: '6px 10px', fontSize: 13 }} /></td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    <button className="action-btn edit-btn" onClick={() => inlineSave(t.id)} style={{ background: 'var(--success)', color: '#fff' }}>Save</button>
                    <button className="action-btn del-btn" onClick={() => setEditTeacherId(null)}>Cancel</button>
                  </td>
                </tr>
              );
              return (
                <tr key={t.id}>
                  <td>{i + 1}</td>
                  <td style={{ fontWeight: 600, color: 'var(--text)' }}>{t.name}</td>
                  <td><span className="badge badge-blue">{t.subject}</span></td>
                  <td style={{ color: 'var(--accent3)' }}>{t.notes || 'Any Stage'}</td>
                  <td>
                    <button className="action-btn edit-btn" onClick={() => startEdit(t)}>Edit</button>
                    {isAdmin && <button className="action-btn del-btn" onClick={() => deleteTeacher(t.id)}>Remove</button>}
                  </td>
                </tr>
              );
            })}
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
          {/* Row 1: Corner + Week Labels */}
          <div className="sg-corner">Grade</div>
          <div className="sg-week-label" style={{ gridColumn: 'span 6', color: 'var(--accent)', background: 'rgba(0,212,255,0.08)' }}>── Week 1 ──</div>
          <div className="sg-week-label sg-w2-sep" style={{ gridColumn: 'span 6', color: 'var(--accent2)', background: 'rgba(255,107,53,0.08)' }}>── Week 2 ──</div>
          {/* Row 2: Corner + Day Names */}
          <div className="sg-header">Grade</div>
          {WEEK1_DAYS.map(d => <div key={d} className="sg-header">{d.replace('W1-','').slice(0,3)}</div>)}
          {WEEK2_DAYS.map(d => <div key={d} className="sg-header sg-w2-sep">{d.replace('W2-','').slice(0,3)}</div>)}
          {/* Data Rows */}
          {GRADES.map(grade => (
            <React.Fragment key={grade}>
              <div className="sg-grade">{grade}</div>
              {WEEK1_DAYS.map(day => {
                const cell = getCell(grade, day);
                return (
                  <div key={day} className="sg-cell">
                    <input type="number" min="0" placeholder="Comms" value={cell.committees || ''} onChange={e => updateCell(grade, day, 'committees', parseInt(e.target.value) || 0)} readOnly={!(isAdmin || userPermissions.includes('schedule_edit'))} style={!(isAdmin || userPermissions.includes('schedule_edit')) ? { opacity: 0.7, cursor: 'not-allowed' } : {}} />
                    <select value={cell.subject || ''} onChange={e => updateCell(grade, day, 'subject', e.target.value)} disabled={!(isAdmin || userPermissions.includes('schedule_edit'))} style={!(isAdmin || userPermissions.includes('schedule_edit')) ? { opacity: 0.7, cursor: 'not-allowed' } : {}}>
                      <option value="">Subject</option>
                      {SUBJECTS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <input type="text" placeholder="Time" value={cell.time || ''} onChange={e => updateCell(grade, day, 'time', e.target.value)} readOnly={!(isAdmin || userPermissions.includes('schedule_edit'))} style={!(isAdmin || userPermissions.includes('schedule_edit')) ? { opacity: 0.7, cursor: 'not-allowed' } : {}} />
                  </div>
                );
              })}
              {WEEK2_DAYS.map(day => {
                const cell = getCell(grade, day);
                return (
                  <div key={day} className="sg-cell sg-w2-cell">
                    <input type="number" min="0" placeholder="Comms" value={cell.committees || ''} onChange={e => updateCell(grade, day, 'committees', parseInt(e.target.value) || 0)} readOnly={!(isAdmin || userPermissions.includes('schedule_edit'))} style={!(isAdmin || userPermissions.includes('schedule_edit')) ? { opacity: 0.7, cursor: 'not-allowed' } : {}} />
                    <select value={cell.subject || ''} onChange={e => updateCell(grade, day, 'subject', e.target.value)} disabled={!(isAdmin || userPermissions.includes('schedule_edit'))} style={!(isAdmin || userPermissions.includes('schedule_edit')) ? { opacity: 0.7, cursor: 'not-allowed' } : {}}>
                      <option value="">Subject</option>
                      {SUBJECTS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <input type="text" placeholder="Time" value={cell.time || ''} onChange={e => updateCell(grade, day, 'time', e.target.value)} readOnly={!(isAdmin || userPermissions.includes('schedule_edit'))} style={!(isAdmin || userPermissions.includes('schedule_edit')) ? { opacity: 0.7, cursor: 'not-allowed' } : {}} />
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
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer', padding: '8px 12px', background: 'rgba(255,107,53,0.06)', borderRadius: 8, border: '1px solid rgba(255,107,53,0.15)' }}>
              <input type="checkbox" id="rule-admin-w2" defaultChecked={false} style={{ width: 16, height: 16, accentColor: 'var(--accent2)' }} />
              <span style={{ color: 'var(--accent2)', fontWeight: 600 }}>Admin in Week 2 only</span>
              <span style={{ fontSize: 11, color: 'var(--text2)' }}>(peak days, last resort)</span>
            </label>
            <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.6, padding: '4px 0' }}>
              • Chronological day-by-day processing<br/>
              • MAX 2 committees per teacher per day (hard rule)<br/>
              • Admin = LAST resort, fewer hours than others<br/>
              • Hours balanced from actual assignments<br/>
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

    const STAGE_LABELS: Record<string, string> = { primary: 'Primary', prep: 'Prep', sec: 'Secondary' };
    const STAGE_COLORS: Record<string, string> = { primary: '#f59e0b', prep: '#8b5cf6', sec: '#06b6d4' };

    return (
      <div>
        <div style={{ marginBottom: 16, display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" onClick={exportPDF}>📄 Download PDF (A4 Printable)</button>
        </div>
        {DAYS.map((day, idx) => {
          const sessions = results.assignments[day] || [];
          const dayStandbys = results.standbys?.[day];
          const hasStandby = dayStandbys && Object.values(dayStandbys).some(s => s.length > 0);
          if (sessions.length === 0 && !hasStandby) return null;
          const displayDay = day.replace('W1-','Week 1 - ').replace('W2-','Week 2 - ');
          // Week separator before first W2 day
          const weekSep = idx === WEEK1_DAYS.length ? (
            <div key="w2-sep" style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0 8px', color: 'var(--accent2)', fontWeight: 700, fontSize: 14 }}>
              <span style={{ flex: 1, height: 1, background: 'linear-gradient(90deg, var(--accent2), transparent)' }} />
              ── Week 2 ──
              <span style={{ flex: 1, height: 1, background: 'linear-gradient(270deg, var(--accent2), transparent)' }} />
            </div>
          ) : null;
          return (
            <React.Fragment key={day}>
              {weekSep}
            <div className="result-day">
              <div className="result-day-header" onClick={() => {
                const body = document.getElementById('day-body-' + day);
                if (body) body.style.display = body.style.display === 'none' ? 'block' : 'none';
              }}>
                <div className="result-day-title">📅 {displayDay} </div>
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
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#f59e0b', marginBottom: 8 }}>📍 Available Teachers (Standby)</div>
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
            </React.Fragment>
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
                  {WEEK1_DAYS.map(d => <th key={d}>{d.replace('W1-','').slice(0,3)}</th>)}
                  {WEEK2_DAYS.map(d => <th key={d} style={{ borderLeft: '2px solid var(--accent2)' }}>{d.replace('W2-','').slice(0,3)}</th>)}
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
                      {DAYS.map((d, di) => {
                        const val = ts.dayComm[d] || 0;
                        const cellColor = val >= 2 ? 'var(--danger)' : val === 1 ? 'var(--accent3)' : 'var(--text2)';
                        return <td key={d} style={{ textAlign: 'center', fontWeight: 600, color: cellColor, ...(di === WEEK1_DAYS.length ? { borderLeft: '2px solid var(--accent2)' } : {}) }}>{val || '-'}</td>;
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
                  {DAYS.map((d, di) => {
                    const dayTotal = teachers.reduce((a, t) => a + teacherStats[t.id].dayComm[d], 0);
                    return <td key={d} style={{ textAlign: 'center', color: 'var(--accent)', ...(di === WEEK1_DAYS.length ? { borderLeft: '2px solid var(--accent2)' } : {}) }}>{dayTotal}</td>;
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

  // ========== USERS PAGE (Admin Only) ==========
  const renderUsersPage = () => {
    const saveSupervisor = async () => {
      if (!supFormName.trim() || !supFormPass.trim()) { showToast('Name and password required', 'error'); return; }
      try {
        const res = await fetch('/api/supervisors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: editingSupId, name: supFormName.trim(), password: supFormPass, permissions: supFormPermissions })
        });
        if (res.ok) {
          const data = await res.json();
          setSupervisors(data.supervisors);
          logAudit(editingSupId ? 'user_edited' : 'user_added', `${editingSupId ? 'Edited' : 'Added'} supervisor: ${supFormName.trim()}`);
          showToast(editingSupId ? 'User updated' : 'User added', 'success');
          setSupFormName(''); setSupFormPass(''); setEditingSupId(null); setSupFormPermissions([]);
        }
      } catch { showToast('Error saving user', 'error'); }
    };

    const deleteSupervisor = async (id: string, name: string) => {
      if (!confirm(`Delete user "${name}"?`)) return;
      try {
        await fetch(`/api/supervisors?id=${id}`, { method: 'DELETE' });
        setSupervisors(prev => prev.filter(s => s.id !== id));
        logAudit('user_deleted', `Deleted supervisor: ${name}`);
        showToast('User deleted', 'success');
      } catch { showToast('Error deleting', 'error'); }
    };

    return (
      <div className="card">
        <div className="card-header">
          <div className="card-title">Manage Supervisors</div>
        </div>
        <div style={{ background: 'var(--surface2)', borderRadius: 10, padding: 20, marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10, fontWeight: 600 }}>
            {editingSupId ? 'EDIT SUPERVISOR' : 'ADD NEW SUPERVISOR'}
          </div>
          <div className="grid-3">
            <div className="form-group">
              <label className="form-label">Full Name</label>
              <input className="form-input" value={supFormName} onChange={e => setSupFormName(e.target.value)} placeholder="e.g. Ahmed Mohamed" />
            </div>
            <div className="form-group">
              <label className="form-label">Password</label>
              <input className="form-input" type="text" value={supFormPass} onChange={e => setSupFormPass(e.target.value)} placeholder={editingSupId ? 'Leave blank to keep current' : 'Set password'} />
            </div>
            <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
              <button className="btn btn-primary" onClick={saveSupervisor} style={{ flex: 1 }}>
                {editingSupId ? '✓ Update' : '+ Add User'}
              </button>
              {editingSupId && (
                <button className="btn btn-ghost" onClick={() => { setEditingSupId(null); setSupFormName(''); setSupFormPass(''); setSupFormPermissions([]); }}>Cancel</button>
              )}
            </div>
          </div>
          <div style={{ marginTop: 12, padding: '12px 16px', background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10, fontWeight: 600 }}>Access Permissions:</div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              {['teachers', 'schedule', 'results', 'stats'].map(perm => (
                <div key={perm} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: 'var(--text)' }}>
                    <input
                      type="checkbox"
                      checked={supFormPermissions.includes(perm)}
                      onChange={e => {
                        if (e.target.checked) setSupFormPermissions(prev => [...prev, perm]);
                        else setSupFormPermissions(prev => prev.filter(p => p !== perm && p !== 'schedule_edit'));
                      }}
                      style={{ width: 16, height: 16, accentColor: 'var(--accent)' }}
                    />
                    {perm === 'teachers' ? 'Teachers Page' : perm === 'schedule' ? 'Schedule Page' : perm === 'results' ? 'Results Page' : 'Statistics Page'}
                  </label>
                  {perm === 'schedule' && supFormPermissions.includes('schedule') && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', color: 'var(--text2)', paddingLeft: 22 }}>
                      <input
                        type="checkbox"
                        checked={supFormPermissions.includes('schedule_edit')}
                        onChange={e => {
                          if (e.target.checked) setSupFormPermissions(prev => [...prev, 'schedule_edit']);
                          else setSupFormPermissions(prev => prev.filter(p => p !== 'schedule_edit'));
                        }}
                        style={{ width: 14, height: 14, accentColor: 'var(--accent2)' }}
                      />
                      Can Edit Schedule?
                    </label>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th><th>Name</th><th>Permissions</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {supervisors.length === 0 ? (
                <tr><td colSpan={4} style={{ textAlign: 'center', padding: 32, color: 'var(--text2)' }}>No supervisors added yet. Add users above.</td></tr>
              ) : supervisors.map((s, i) => (
                <tr key={s.id}>
                  <td style={{ color: 'var(--text2)' }}>{i + 1}</td>
                  <td style={{ fontWeight: 600, color: 'var(--text)' }}>{s.name}</td>
                  <td style={{ fontSize: 12 }}>
                    {(s.permissions && s.permissions.length > 0) ? s.permissions.map(p => (
                      <span key={p} className="badge badge-blue" style={{ marginRight: 4, ...(p === 'schedule_edit' ? { background: 'var(--accent2)', color: '#fff' } : {}) }}>{p === 'schedule_edit' ? 'Edit' : p}</span>
                    )) : <span style={{ color: 'var(--text2)' }}>Default (view only)</span>}
                  </td>
                  <td>
                    <button className="action-btn edit-btn" onClick={() => { setEditingSupId(s.id); setSupFormName(s.name); setSupFormPass(''); setSupFormPermissions(s.permissions || []); }}>Edit</button>
                    <button className="action-btn del-btn" onClick={() => deleteSupervisor(s.id, s.name)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  // ========== LOG PAGE (Admin Only) — single tab with sub-view choice ==========
  const renderLogPage = () => {
    const entries = logView === 'admin'
      ? auditLog.filter(e => e.user === 'Admin')
      : auditLog.filter(e => e.user !== 'Admin');
    const showUser = logView === 'users';
    return (
      <div className="card">
        <div className="card-header">
          <div className="card-title">Activity Log</div>
          <button className="btn btn-ghost" onClick={loadAuditLog}>↻ Refresh</button>
        </div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
          <button
            onClick={() => setLogView('admin')}
            style={{
              flex: 1, padding: '14px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
              fontFamily: 'var(--sans)', fontSize: 14, fontWeight: 700, transition: 'all 0.2s',
              background: logView === 'admin' ? 'var(--accent2)' : 'var(--surface2)',
              color: logView === 'admin' ? '#fff' : 'var(--text2)'
            }}
          >
            🔐 Admin Log
          </button>
          <button
            onClick={() => setLogView('users')}
            style={{
              flex: 1, padding: '14px 20px', borderRadius: 10, border: 'none', cursor: 'pointer',
              fontFamily: 'var(--sans)', fontSize: 14, fontWeight: 700, transition: 'all 0.2s',
              background: logView === 'users' ? 'var(--accent)' : 'var(--surface2)',
              color: logView === 'users' ? 'var(--bg)' : 'var(--text2)'
            }}
          >
            👥 Users Log
          </button>
        </div>
        {entries.length === 0 ? (
          <div className="empty-state"><p>No {logView === 'admin' ? 'admin' : 'user'} activity recorded yet.</p></div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: '70vh', overflow: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Time</th>{showUser && <th>User</th>}<th>Action</th><th>Details</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => {
                  const time = new Date(entry.timestamp);
                  const timeStr = time.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
                  const actionColor = entry.action.includes('delete') ? 'var(--danger)' : entry.action.includes('add') ? 'var(--accent3)' : 'var(--accent)';
                  return (
                    <tr key={entry.id || i}>
                      <td style={{ color: 'var(--text2)' }}>{i + 1}</td>
                      <td style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{timeStr}</td>
                      {showUser && <td style={{ fontWeight: 600, color: 'var(--text)' }}>{entry.user}</td>}
                      <td><span className="badge" style={{ background: `${actionColor}15`, color: actionColor, textTransform: 'capitalize' }}>{entry.action.replace(/_/g, ' ')}</span></td>
                      <td style={{ color: 'var(--text2)', fontSize: 12 }}>{entry.details}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  // ========== MAIN APP RENDER ==========
  const hasResults = !!(results?.assignments && results?.standbys && results?.tracking);
  const pages: { key: Page; label: string; adminOnly: boolean; requiresResults?: boolean }[] = [
    { key: 'teachers', label: '👨‍🏫 Teachers', adminOnly: false },
    { key: 'schedule', label: '📅 Schedule', adminOnly: false },
    { key: 'distribute', label: '⚡ Distribute', adminOnly: true },
    { key: 'results', label: '📋 Results', adminOnly: false },
    { key: 'stats', label: '📊 Statistics', adminOnly: false, requiresResults: true },
    { key: 'users', label: '👥 Users', adminOnly: true },
    { key: 'log', label: '📝 Log', adminOnly: true },
  ];

  const visiblePages = pages.filter(p => {
    if (!canAccessPage(p.key)) return false;
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
            {activePage === 'users' && renderUsersPage()}
            {activePage === 'log' && renderLogPage()}
          </>
        )}
      </main>

      {/* Toast */}
      <div id="app-toast" className="toast" />
    </div>
  );
}