'use client';

export const dynamic = 'force-dynamic';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createClient, RealtimeChannel } from '@supabase/supabase-js';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';

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
interface SessionResult { grade: string; time: string; subject: string; committees: CommitteeResult[]; standbys: StandbyEntry[]; }
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
  const [showAdminBtn, setShowAdminBtn] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showLoginPass, setShowLoginPass] = useState(false);
  const [showCurPass, setShowCurPass] = useState(false);
  const [showNewPass, setShowNewPass] = useState(false);
  const [showConfPass, setShowConfPass] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changePassError, setChangePassError] = useState('');
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
  const [changeSupPass, setChangeSupPass] = useState(false);
  const [supFormPermissions, setSupFormPermissions] = useState<string[]>([]);

  // Data state
  // Secret keydown: press 'm' on login screen to reveal admin button
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (view === 'login' && !loginMode && e.key.toLowerCase() === 'm') {
        setShowAdminBtn(prev => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [view, loginMode]);

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
          if (!d._version || d._version < 11) {
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
    if (role === 'user' && !selectedSupervisor.trim()) { setLoginError('Please enter your username'); return; }
    if (!password.trim()) { setLoginError('Please enter the password'); return; }
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, role, name: role === 'user' ? selectedSupervisor.trim() : undefined })
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

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      setChangePassError('Please fill all fields'); return;
    }
    if (newPassword.length < 4) {
      setChangePassError('Password must be at least 4 characters'); return;
    }
    if (newPassword !== confirmPassword) {
      setChangePassError('New password and confirmation do not match'); return;
    }
    try {
      // First verify current password
      const verifyRes = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: currentPassword, role: 'user', name: currentUser })
      });
      const verifyData = await verifyRes.json();
      if (!verifyData.success) {
        setChangePassError('Current password is wrong'); return;
      }
      // Update password
      const updateRes = await fetch('/api/supervisors', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: currentUser, newPassword })
      });
      const updateData = await updateRes.json();
      if (updateData.success) {
        showToast('Password updated successfully', 'success');
        setShowChangePassword(false);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setChangePassError('');
      } else {
        setChangePassError('Failed to update password');
      }
    } catch {
      setChangePassError('Connection error');
    }
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
    setShowChangePassword(false);
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
  const cellKey = (grade: string, day: string, session: number = 1): string =>
    session === 1 ? `${grade}__${day}` : `${grade}__${day}__${session}`;

  const updateCell = (grade: string, day: string, field: 'committees' | 'subject' | 'time', value: string | number, session: number = 1) => {
    const key = cellKey(grade, day, session);
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
    const gradingPref = (document.getElementById('rule-grading-pref') as HTMLInputElement)?.checked ?? false;

    // ---- Admin handling: Admin subject excluded by default, included only for W2 peak days ----

    // ---- Helper: Check if teacher has secondary supervision notes ----
    const hasSecNotes = (t: Teacher): boolean => {
      if (!t.notes || t.notes.trim() === '') return false;
      const n = t.notes.toLowerCase();
      return /\b(secondary|sec)\b/i.test(n) || n.includes('\u062b\u0627\u0646\u0648\u064a');
    };

    // ---- Helper: Check if a session time is "first session" (morning, before 11:00 = 660 min) ----
    const isFirstSession = (startMin: number): boolean => startMin < 660;

    // ---- Build map: day -> set of subjects examined that day (for grading preference) ----
    const subjectsByDay: Record<string, Set<string>> = {};
    DAYS.forEach(d => { subjectsByDay[d] = new Set(); });
    // Will be populated after slots are built below

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
    const MAX_SESSIONS = 2;
    DAYS.forEach((day, dayIndex) => {
      GRADES.forEach(grade => {
        for (let s = 1; s <= MAX_SESSIONS; s++) {
          const key = s === 1 ? `${grade}__${day}` : `${grade}__${day}__${s}`;
          const cell = scheduleBuffer[key];
          if (cell && cell.committees > 0) {
            const timeInfo = parseTimeRange(cell.time || DEFAULT_TIMES[grade] || '9:00-10:30');
            for (let c = 1; c <= cell.committees; c++) {
              slotsByDay[day].push({ day, dayIndex, grade, stage: getStage(grade), subject: cell.subject || '', time: cell.time || DEFAULT_TIMES[grade] || '9:00-10:30', timeInfo, comId: c });
            }
          }
        }
      });
    });

    // Populate subjectsByDay: which subjects have exams on each day
    for (const day of DAYS) {
      for (const slot of slotsByDay[day]) {
        if (slot.subject) subjectsByDay[day].add(slot.subject);
      }
    }

    // ---- Grading preference helpers (activated by toggle) ----
    // Rule A: Teachers whose subject was examined yesterday → prefer first session today (partial, not all)
    // Rule B: Admin subject teachers → 2-3 supervisions max in W2
    // Rule C: Admin subject teachers → available for standby if pressure

    // Track Admin W2 supervision count (max 3)
    const adminW2Count: Record<string, number> = {};
    teachers.forEach(t => { adminW2Count[t.id] = 0; });

    // Is teacher's subject was examined the PREVIOUS day? (for first-session preference)
    const isSubjectExaminedYesterday = (teacher: Teacher, day: string): boolean => {
      if (!gradingPref) return false;
      if (teacher.subject === 'Admin') return false; // Admin handled separately
      const idx = DAYS.indexOf(day);
      if (idx <= 0) return false;
      const prevDay = DAYS[idx - 1];
      const prevSubjs = subjectsByDay[prevDay];
      if (!prevSubjs) return false;
      return prevSubjs.has(teacher.subject);
    };

    // Is this an Admin teacher in W2 needing count tracking?
    const isAdminInW2 = (teacher: Teacher, day: string): boolean => {
      if (!gradingPref) return false;
      return teacher.subject === 'Admin' && WEEK2_DAYS.includes(day);
    };

    // ---- Build final assignments structure ----
    const finalAssignments: Record<string, SessionResult[]> = {};
    DAYS.forEach(d => { finalAssignments[d] = []; });
    DAYS.forEach(day => {
      GRADES.forEach(grade => {
        for (let s = 1; s <= MAX_SESSIONS; s++) {
          const key = s === 1 ? `${grade}__${day}` : `${grade}__${day}__${s}`;
          const cell = scheduleBuffer[key];
          if (cell && cell.committees > 0) {
            const existing = finalAssignments[day].find(ex => ex.grade === grade && ex.time === (cell.time || DEFAULT_TIMES[grade]));
            if (!existing) {
              finalAssignments[day].push({ grade, time: cell.time || DEFAULT_TIMES[grade] || '', subject: cell.subject || '', committees: [], standbys: [] });
            }
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
        // HARD: Admin teachers: max 3 supervisions during Week 2 (when grading pref ON)
        if (isAdminInW2(t, slot.day) && (adminW2Count[t.id] || 0) >= 3) continue;
        // SOFT: No same grade on consecutive days (can be relaxed)
        if (!relaxAdj && wasSameGradeAdjacent(tr, slot)) continue;
        // Scoring: HOURS dominate (500x), then committees (10x), tiny noise for variety
        // Admin subject = HEAVY penalty (always last choice)
        const isAdmin = t.subject === 'Admin';
        // Admin penalty: when grading pref ON in W2, Admin is a normal candidate (not last resort)
        // When grading pref OFF or not W2, Admin stays as heavy penalty (last resort)
        const adminPenalty = isAdmin ? (gradingPref && WEEK2_DAYS.includes(slot.day) ? 500 : 50000) : 0;
        // Grading preference: if teacher's subject was examined yesterday,
        // prefer first session (soft bonus, partial — not all teachers get it)
        let gradingBonus = 0;
        if (isSubjectExaminedYesterday(t, slot.day)) {
          if (isFirstSession(slot.timeInfo.start)) {
            gradingBonus = -80; // soft preference for first session (partial coverage)
          } else {
            gradingBonus = 120; // soft discourage for second session
          }
        }
        const score = tr.totalHours * 500 + tr.totalComm * 10 + adminPenalty + gradingBonus + Math.random() * 0.1;
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

        // Helper: filter old teachers not exceeding 3-day max, not already assigned today, and ONLY for secondary slots
        const availableOldTeachers = (blockedId: string | null, day: string) => {
          return oldTeachers.filter(ot => {
            if (blockedId && ot.id === blockedId) return false;
            if ((oldTeacherDays[ot.id] || 0) >= 3) return false;
            // RULE: Old teachers supervise SECONDARY ONLY
            if (slot.stage !== 'sec') return false;
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
          // Track Admin W2 count
          if (isAdminInW2(t1, slot.day)) {
            adminW2Count[t1.id] = (adminW2Count[t1.id] || 0) + 1;
          }
        } else { standbyCount++; }

        // T2: pairing rule — classified teacher (has notes) must pair with unclassified
        // ADDITIONAL: if T1 is old teacher, T2 must have secondary notes (relaxable)
        // ADDITIONAL: if T2 ends up being old, T1 must have secondary notes (checked after T2 found)
        const blocked = t1?.id || null;
        const t1Classified = t1 ? !!(t1.notes && t1.notes.trim() !== '') : false;
        const t1IsOld = t1 ? isOldTeacher(t1) : false;

        let t2Pool: Teacher[] = dayPool.filter(t => t.id !== blocked);
        // Classified pairing: if T1 has notes, T2 should have no notes
        if (t1Classified && !t1IsOld) {
          t2Pool = t2Pool.filter(t => !t.notes || t.notes.trim() === '');
        }
        // Old teacher pairing: if T1 is old, T2 MUST have secondary supervision notes
        if (t1IsOld) {
          const secNotePool = t2Pool.filter(t => hasSecNotes(t));
          if (secNotePool.length > 0) {
            t2Pool = secNotePool;
          }
          // If no sec-note teachers available, relax (use full pool)
        }

        t2 = findBest(blocked, slot, t2Pool, false);
        if (!t2) t2 = findBest(blocked, slot, t2Pool, true);
        if (!t2) t2 = findBestRelaxed(blocked, slot, t2Pool);
        if (!t2) t2 = findBestForceDay(blocked, slot, t2Pool);
        // Relax pairing rule if no suitable teacher found
        if (!t2 && (t1Classified || t1IsOld)) {
          t2 = findBest(blocked, slot, dayPool, false);
          if (!t2) t2 = findBest(blocked, slot, dayPool, true);
          if (!t2) t2 = findBestRelaxed(blocked, slot, dayPool);
          if (!t2) t2 = findBestForceDay(blocked, slot, dayPool);
        }
        // Last resort: try old teachers for T2 (only for sec slots)
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
          // Track Admin W2 count
          if (isAdminInW2(t2, slot.day)) {
            adminW2Count[t2.id] = (adminW2Count[t2.id] || 0) + 1;
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

    // ---- Post-distribution: STANDBY ASSIGNMENT (per-session) ----
    // Each grade session gets its own 1-2 standby supervisors
    // Standby must NOT have a time-overlapping assignment, and subject exclusion rules apply
    // Rotation: prefer teachers who weren't standby recently, fewest total standby count
    const standbys: Record<string, Record<string, StandbyEntry[]>> = {}; // backward compat (empty)

    // Track standby count per teacher for rotation fairness
    const teacherStandbyCount: Record<string, number> = {};
    teachers.forEach(t => { teacherStandbyCount[t.id] = 0; });

    // Track which teachers are already standby at a given time on a given day
    // Key: "day__start__end" → Set of teacher IDs
    const todayStandbyByTime: Record<string, Set<string>> = {};

    for (let di = 0; di < DAYS.length; di++) {
      const day = DAYS[di];

      // Determine pool for standby (same logic as distribution)
      const isW2Peak = WEEK2_DAYS.includes(day) && peakW2Days.has(day);
      const dayStandbyPool = (includeAdminW2 && isW2Peak) ? [...teachers] : nonAdminTeachers;

      const daySessions = finalAssignments[day] || [];

      for (const session of daySessions) {
        if (session.committees.length === 0) continue;

        const sessTimeInfo = parseTimeRange(session.time);
        const stage = getStage(session.grade);
        const timeKey = `${day}__${sessTimeInfo.start}__${sessTimeInfo.end}`;

        // Initialize time-key tracking set
        if (!todayStandbyByTime[timeKey]) todayStandbyByTime[timeKey] = new Set();

        // Find candidates who:
        // 1. can supervise this stage
        // 2. do NOT have a time-overlapping assignment on this day
        // 3. subject doesn't match session.subject (if ruleSubject)
        // 4. not already standby for another session at same time on same day
        // 5. special subject exclusion still applies
        let candidates = dayStandbyPool.filter(t => {
          // Stage compatibility
          if (!canSuperviseStage(t, stage)) return false;

          // No time-overlapping assignment on this day
          const tr = tracking[t.id];
          if (tr.assignedSlots.some(s => s.day === day && !(sessTimeInfo.end <= s.start || sessTimeInfo.start >= s.end))) return false;

          // Own-subject exclusion
          if (ruleSubject && session.subject && t.subject === session.subject) return false;

          // Special subject exclusion (Religion/Arabic)
          if (ruleSubject && session.subject === 'الدين' && (t.subject === 'الدين' || t.subject === 'العربي')) return false;
          if (ruleSubject && session.subject === 'العربي' && t.subject === 'الدين' && stage === 'primary') return false;

          // Not already standby at this same time on this day
          if (todayStandbyByTime[timeKey].has(t.id)) return false;

          return true;
        });

        // Rotation: deprioritize teachers who were standby YESTERDAY for ANY session
        const yesterdayStandby = new Set<string>();
        if (di > 0) {
          const prevDay = DAYS[di - 1];
          for (const prevSess of (finalAssignments[prevDay] || [])) {
            prevSess.standbys.forEach(s => yesterdayStandby.add(s.id));
          }
        }

        // Check if teacher is completely free today (no assignments at all on this day)
        const isCompletelyFreeToday = (t: Teacher): boolean => {
          const tr = tracking[t.id];
          return !tr.assignedSlots.some(s => s.day === day);
        };

        candidates.sort((a, b) => {
          const aWasYesterday = yesterdayStandby.has(a.id) ? 100 : 0;
          const bWasYesterday = yesterdayStandby.has(b.id) ? 100 : 0;
          const aFree = isCompletelyFreeToday(a) ? 0 : 10;
          const bFree = isCompletelyFreeToday(b) ? 0 : 10;
          return (teacherStandbyCount[a.id] + aWasYesterday + aFree) - (teacherStandbyCount[b.id] + bWasYesterday + bFree);
        });

        // Pick min(2, candidates.length) teachers
        const picked = candidates.slice(0, Math.min(2, candidates.length));
        session.standbys = picked.map(t => ({ id: t.id, name: t.name }));

        // Track rotation count and mark as standby at this time slot
        for (const s of picked) {
          teacherStandbyCount[s.id]++;
          todayStandbyByTime[timeKey].add(s.id);
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

    // V-Check 8: Old teachers must only supervise secondary
    if (ruleNotes) {
      for (const day of DAYS) {
        for (const sess of finalAssignments[day]) {
          const stage = getStage(sess.grade);
          if (stage === 'sec') continue; // old teachers ARE allowed in sec, skip
          for (const c of sess.committees) {
            [c.t1, c.t2].forEach(who => {
              if (!who.id) return;
              const tch = teachers.find(x => x.id === who.id);
              if (tch && isOldTeacher(tch)) {
                violations.push(`${tch.name} -> old teacher in non-secondary stage (${stage}) on ${day}`);
              }
            });
          }
        }
      }
    }

    // V-Check 9: Admin teachers W2 max 3 (when grading pref ON)
    if (gradingPref) {
      for (const t of teachers) {
        if (t.subject !== 'Admin') continue;
        const w2Count = adminW2Count[t.id] || 0;
        if (w2Count > 3) {
          violations.push(`${t.name} -> Admin teacher assigned ${w2Count} times in W2 (max 3)`);
        }
      }
    }

    // ---- Build summary statistics (from verified tracking) ----
    const allH = teachers.map(t => tracking[t.id]?.totalHours || 0);
    const avgAll = allH.length ? allH.reduce((a, b) => a + b, 0) / allH.length : 0;
    const spread = allH.length ? Math.sqrt(allH.reduce((s, h) => s + (h - avgAll) ** 2, 0) / allH.length) : 0;
    let msg = `v10 | Avg: ${avgAll.toFixed(1)}h | Spread: ${spread.toFixed(1)} | Min: ${allH.length ? Math.min(...allH).toFixed(1) : 0}h | Max: ${allH.length ? Math.max(...allH).toFixed(1) : 0}h`;
    // Count total standby assigned (from per-session standbys)
    const totalStandby = Object.values(finalAssignments).flat().reduce((a, s) => a + s.standbys.length, 0);
    if (totalStandby > 0) msg += ` | ${totalStandby} standby (per-session)`;
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
        // Per-session standby rows
        if (s.standbys && s.standbys.length > 0) {
          for (const st of s.standbys) {
            csv += `"${displayDay}","${s.grade}","${s.time}","${s.subject || ''}","Standby","${st.name}","","Standby"\n`;
          }
        }
      });
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
    showToast('Generating PDF...', 'info');

    const DAY_AR: Record<string, string> = {
      'W1-Saturday': '\u0627\u0644\u0633\u0628\u062a', 'W1-Sunday': '\u0627\u0644\u0623\u062d\u062f', 'W1-Monday': '\u0627\u0644\u0627\u062b\u0646\u064a\u0646',
      'W1-Tuesday': '\u0627\u0644\u062b\u0644\u0627\u062b\u0627\u0621', 'W1-Wednesday': '\u0627\u0644\u0623\u0631\u0628\u0639\u0627\u0621', 'W1-Thursday': '\u0627\u0644\u062e\u0645\u064a\u0633',
      'W2-Saturday': '\u0627\u0644\u0633\u0628\u062a', 'W2-Sunday': '\u0627\u0644\u0623\u062d\u062f', 'W2-Monday': '\u0627\u0644\u0627\u062b\u0646\u064a\u0646',
      'W2-Tuesday': '\u0627\u0644\u062b\u0644\u0627\u062b\u0627\u0621', 'W2-Wednesday': '\u0627\u0644\u0623\u0631\u0628\u0639\u0627\u0621', 'W2-Thursday': '\u0627\u0644\u062e\u0645\u064a\u0633',
    };
    const WEEK_AR: Record<string, string> = { 'W1': '\u0627\u0644\u0623\u0633\u0628\u0648\u0639 \u0627\u0644\u0623\u0648\u0644', 'W2': '\u0627\u0644\u0623\u0633\u0628\u0648\u0639 \u0627\u0644\u062b\u0627\u0646\u064a' };
    const GRADE_AR: Record<string, string> = {
      'Grade 3 Primary': '\u0627\u0644\u0635\u0641 \u0627\u0644\u062b\u0627\u0644\u062b \u0627\u0644\u0627\u0628\u062a\u062f\u0627\u0626\u064a', 'Grade 4 Primary': '\u0627\u0644\u0635\u0641 \u0627\u0644\u0631\u0627\u0628\u0639 \u0627\u0644\u0627\u0628\u062a\u062f\u0627\u0626\u064a',
      'Grade 5 Primary': '\u0627\u0644\u0635\u0641 \u0627\u0644\u062e\u0627\u0645\u0633 \u0627\u0644\u0627\u0628\u062a\u062f\u0627\u0626\u064a', 'Grade 6 Primary': '\u0627\u0644\u0635\u0641 \u0627\u0644\u0633\u0627\u062f\u0633 \u0627\u0644\u0627\u0628\u062a\u062f\u0627\u0626\u064a',
      'Grade 1 Prep': '\u0627\u0644\u0635\u0641 \u0627\u0644\u0623\u0648\u0644 \u0627\u0644\u0625\u0639\u062f\u0627\u062f\u064a', 'Grade 2 Prep': '\u0627\u0644\u0635\u0641 \u0627\u0644\u062b\u0627\u0646\u064a \u0627\u0644\u0625\u0639\u062f\u0627\u062f\u064a',
      'Grade 1 Secondary': '\u0627\u0644\u0635\u0641 \u0627\u0644\u0623\u0648\u0644 \u0627\u0644\u062b\u0627\u0646\u0648\u064a', 'Grade 2 Secondary': '\u0627\u0644\u0635\u0641 \u0627\u0644\u062b\u0627\u0646\u064a \u0627\u0644\u062b\u0627\u0646\u0648\u064a',
    };
    let htmlPages = '';
    for (const day of DAYS) {
      const sessions = results.assignments[day] || [];
      if (sessions.length === 0) continue;
      const weekKey = day.startsWith('W1') ? 'W1' : 'W2';
      const dayAr = DAY_AR[day] || day;
      const weekAr = WEEK_AR[weekKey] || '';
      for (const session of sessions) {
        if (session.committees.length === 0 && (!session.standbys || session.standbys.length === 0)) continue;
        const rowsHtml = session.committees.map((c: any) =>
          '<tr><td rowspan="2" class="num-cell">' + c.serial + '</td><td class="name-cell">' + c.t1.name + '</td><td class="sig-cell"></td><td class="notes-cell"></td></tr>' +
          '<tr class="row2"><td class="name-cell">' + c.t2.name + '</td><td class="sig-cell"></td><td class="notes-cell"></td></tr>'
        ).join('');
        let pageHtml = '<div class="page"><div class="header-title">\u062c\u062f\u0648\u0644 \u0625\u0634\u0631\u0627\u0641 \u0627\u0644\u0627\u0645\u062a\u062d\u0627\u0646\u0627\u062a</div>' +
          '<div class="header-info"><div><span class="label">\u0627\u0644\u064a\u0648\u0645:</span> ' + dayAr + ' (' + weekAr + ')</div>' +
          '<div><span class="label">\u0627\u0644\u0635\u0641:</span> ' + (GRADE_AR[session.grade] || session.grade) + '</div>' +
          '<div><span class="label">\u0627\u0644\u0645\u0627\u062f\u0629:</span> ' + (session.subject || '\u2014') + '</div>' +
          '<div><span class="label">\u0627\u0644\u062a\u0648\u0642\u064a\u062a:</span> ' + session.time + '</div></div>' +
          '<table><thead><tr><th class="th-num">\u0645</th><th class="th-name">\u0627\u0644\u0627\u0633\u0645</th><th class="th-sig">\u0627\u0644\u062a\u0648\u0642\u064a\u0639</th><th class="th-notes">\u0627\u0644\u0645\u0644\u0627\u062d\u0638\u0627\u062a</th></tr></thead>' +
          '<tbody>' + rowsHtml + '</tbody></table>';
        // Per-session standby section
        if (session.standbys && session.standbys.length > 0) {
          const stRows = session.standbys.map((s: any, i: number) =>
            '<tr><td class="num-cell">' + (i+1) + '</td><td class="name-cell">' + s.name + '</td><td class="sig-cell"></td><td class="notes-cell"></td></tr>'
          ).join('');
          pageHtml += '<div class="standby-section"><div class="standby-title">\u0627\u0644\u0627\u062d\u062a\u064a\u0627\u0637\u064a</div>' +
            '<table class="standby-table"><thead><tr><th class="th-num">\u0645</th><th class="th-name">\u0627\u0644\u0627\u0633\u0645</th><th class="th-sig">\u0627\u0644\u062a\u0648\u0642\u064a\u0639</th><th class="th-notes">\u0627\u0644\u0645\u0644\u0627\u062d\u0638\u0627\u062a</th></tr></thead>' +
            '<tbody>' + stRows + '</tbody></table></div>';
        }
        pageHtml += '</div>';
        htmlPages += pageHtml;
      }
    }
    if (!htmlPages) { showToast('No results to export', 'error'); return; }

    const css = '*{margin:0;padding:0;box-sizing:border-box}' +
      'body{font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff}' +
      '.page{width:794px;min-height:1123px;padding:50px 40px;background:#fff}' +
      '.header-title{text-align:center;font-size:22px;font-weight:bold;color:#1e3a5f;border-bottom:3px double #1e3a5f;padding-bottom:8px;margin-bottom:16px;width:100%}' +
      '.header-info{display:flex;flex-wrap:wrap;justify-content:space-between;font-size:13px;margin-bottom:16px;padding:10px 14px;background:#f0f4f8;border-radius:6px;border:1px solid #d0d8e0;font-weight:bold}' +
      '.header-info .label{color:#555}' +
      'table{width:100%;border-collapse:collapse;margin-top:10px}' +
      'thead tr{background:#1e3a5f;color:#fff}' +
      'th{border:1px solid #333;padding:8px 6px;text-align:center;font-size:13px}' +
      '.th-num{width:40px}.th-name{width:auto}.th-sig{width:90px}.th-notes{width:130px}' +
      'td{border:1px solid #333;padding:8px 10px;text-align:center;font-size:14px;color:#000}' +
      '.num-cell{font-size:14px;vertical-align:middle;width:40px;color:#000}' +
      '.name-cell{font-weight:bold;font-size:14px;color:#000;text-align:center}' +
      '.sig-cell{width:90px}.notes-cell{width:130px}' +
      'tr.row2 td{border-top:none}' +
      '.standby-section{margin-top:20px;border:2px solid #f59e0b;border-radius:6px;padding:12px 16px;background:#fffbeb}' +
      '.standby-title{font-size:15px;font-weight:bold;color:#b47814;margin-bottom:10px;text-align:center}' +
      '.standby-table{font-size:12px}.standby-table th{background:#b47814;color:#fff;font-size:12px;padding:6px 4px}' +
      '.standby-table td{font-size:13px;padding:6px 8px}';

    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;top:-9999px;left:0;width:794px;z-index:-1;background:#fff;';
    container.innerHTML = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700&display=swap"><style>' + css + '</style><div style="direction:rtl;font-family:\'Cairo\',Arial,Helvetica,sans-serif;color:#000;background:#fff;">' + htmlPages + '</div>';
    document.body.appendChild(container);

    try {
      await new Promise(r => setTimeout(r, 800));
      const pages = container.querySelectorAll('.page');
      const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
      const pdfW = 210, pdfH = 297;

      for (let i = 0; i < pages.length; i++) {
        if (i > 0) pdf.addPage();
        const canvas = await html2canvas(pages[i] as HTMLElement, { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false });
        const imgW = pdfW;
        const imgH = (canvas.height * pdfW) / canvas.width;
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, imgW, Math.min(imgH, pdfH));
      }

      pdf.save('exam-supervision.pdf');
      logAudit('pdf_download', `${currentUser} downloaded exam-supervision.pdf`);
      showToast('PDF downloaded!', 'success');
    } catch (err) {
      console.error('PDF generation error:', err);
      showToast('Error generating PDF', 'error');
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
  const getCell = (grade: string, day: string, session: number = 1): ScheduleCell => {
    const key = cellKey(grade, day, session);
    return scheduleBuffer[key] || { grade, day, committees: 0, subject: '', time: DEFAULT_TIMES[grade] || '9:00-10:30' };
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
              {showAdminBtn && (
              <button
                onClick={() => { setLoginMode('admin'); setLoginError(''); setPassword(''); }}
                style={{ padding: '18px 24px', borderRadius: 12, background: 'var(--accent2)', border: 'none', color: '#fff', fontSize: 16, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--sans)', transition: 'all 0.2s', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}
                onMouseOver={e => { (e.target as HTMLElement).style.background = '#e55a2b'; }}
                onMouseOut={e => { (e.target as HTMLElement).style.background = 'var(--accent2)'; }}
              >
                <span style={{ fontSize: 22 }}>🔐</span> Enter as Admin
              </button>
              )}
            </div>
          ) : (
            /* Step 2: Enter credentials for chosen role */
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 4, color: 'var(--text2)', fontSize: 13 }}>
                <button onClick={() => { setLoginMode(null); setLoginError(''); setPassword(''); setSelectedSupervisor(''); }} style={{ background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: 16, padding: '0 4px', lineHeight: 1 }}>←</button>
                <span>{loginMode === 'user' ? '👤 User Login' : '🔐 Admin Login'}</span>
              </div>
              {loginMode === 'user' && (
                <input
                  type="text"
                  placeholder="Enter your username"
                  value={selectedSupervisor}
                  onChange={e => { setSelectedSupervisor(e.target.value); setLoginError(''); }}
                  autoFocus
                  style={{ padding: '14px 16px', borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 15, fontFamily: 'var(--sans)', outline: 'none', width: '100%' }}
                />
              )}
              <div style={{ position: 'relative' }}>
                <input
                type={showLoginPass ? 'text' : 'password'}
                placeholder={loginMode === 'user' ? 'Enter Password' : 'Enter Admin Password'}
                value={password}
                onChange={e => { setPassword(e.target.value); setLoginError(''); }}
                onKeyDown={e => e.key === 'Enter' && handleLogin(loginMode)}
                autoFocus={loginMode === 'admin'}
                style={{ padding: '14px 44px 14px 16px', borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 15, fontFamily: 'var(--sans)', outline: 'none', textAlign: 'center', width: '100%' }}
              />
              <button type="button" onClick={() => setShowLoginPass(!showLoginPass)} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text2)', padding: 4, lineHeight: 1 }}>{showLoginPass ? '🙈' : '👁'}</button>
              </div>
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
    if (page === 'log') return isAdmin; // Log always admin-only
    if (page === 'distribute') return isAdmin || userPermissions.includes('distribute');
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
              {WEEK1_DAYS.map(day => (
                <div key={day} className="sg-cell">
                  {[1, 2].map(s => {
                    const cell = getCell(grade, day, s);
                    const ro = !(isAdmin || userPermissions.includes('schedule_edit'));
                    return (
                      <div key={s} className={`sg-session sg-session-${s}`}>
                        <div className="sg-session-label">S{s}</div>
                        <input type="number" min="0" placeholder="#" value={cell.committees || ''} onChange={e => updateCell(grade, day, 'committees', parseInt(e.target.value) || 0, s)} readOnly={ro} style={ro ? { opacity: 0.7, cursor: 'not-allowed' } : {}} />
                        <select value={cell.subject || ''} onChange={e => updateCell(grade, day, 'subject', e.target.value, s)} disabled={ro} style={ro ? { opacity: 0.7, cursor: 'not-allowed' } : {}}>
                          <option value="">Subj</option>
                          {SUBJECTS.map(sub => <option key={sub} value={sub}>{sub}</option>)}
                        </select>
                        <input type="text" placeholder="Time" value={cell.time || ''} onChange={e => updateCell(grade, day, 'time', e.target.value, s)} readOnly={ro} style={ro ? { opacity: 0.7, cursor: 'not-allowed' } : {}} />
                      </div>
                    );
                  })}
                </div>
              ))}
              {WEEK2_DAYS.map(day => (
                <div key={day} className="sg-cell sg-w2-cell">
                  {[1, 2].map(s => {
                    const cell = getCell(grade, day, s);
                    const ro = !(isAdmin || userPermissions.includes('schedule_edit'));
                    return (
                      <div key={s} className={`sg-session sg-session-${s}`}>
                        <div className="sg-session-label">S{s}</div>
                        <input type="number" min="0" placeholder="#" value={cell.committees || ''} onChange={e => updateCell(grade, day, 'committees', parseInt(e.target.value) || 0, s)} readOnly={ro} style={ro ? { opacity: 0.7, cursor: 'not-allowed' } : {}} />
                        <select value={cell.subject || ''} onChange={e => updateCell(grade, day, 'subject', e.target.value, s)} disabled={ro} style={ro ? { opacity: 0.7, cursor: 'not-allowed' } : {}}>
                          <option value="">Subj</option>
                          {SUBJECTS.map(sub => <option key={sub} value={sub}>{sub}</option>)}
                        </select>
                        <input type="text" placeholder="Time" value={cell.time || ''} onChange={e => updateCell(grade, day, 'time', e.target.value, s)} readOnly={ro} style={ro ? { opacity: 0.7, cursor: 'not-allowed' } : {}} />
                      </div>
                    );
                  })}
                </div>
              ))}
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
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer', padding: '8px 12px', background: 'rgba(99,179,237,0.06)', borderRadius: 8, border: '1px solid rgba(99,179,237,0.15)' }}>
              <input type="checkbox" id="rule-grading-pref" defaultChecked={false} style={{ width: 16, height: 16, accentColor: 'var(--accent3)' }} />
              <span style={{ color: 'var(--accent3)', fontWeight: 600 }}>W2 Grading Mode</span>
              <span style={{ fontSize: 11, color: 'var(--text2)' }}>(Admin 2-3x, subject→1st session)</span>
            </label>
            <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.6, padding: '4px 0' }}>
              • Chronological day-by-day processing<br/>
              • MAX 2 committees per teacher per day (hard rule)<br/>
              • Admin = LAST resort, fewer hours than others<br/>
              • Hours balanced from actual assignments<br/>
              • No same grade on consecutive days<br/>
              • No time overlap for same teacher<br/>
              • Old teachers (notes: "old") → secondary only, paired with sec-note teacher<br/>
              • <span style={{ color: 'var(--accent3)' }}>W2 Grading:</span> Admin 2-3 duties, subject teachers → 1st session
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

    return (
      <div>
        <div style={{ marginBottom: 16, display: 'flex', gap: 10 }}>
          <button className="btn btn-primary" onClick={exportPDF}>📄 Download PDF (A4 Printable)</button>
        </div>
        {DAYS.map((day, idx) => {
          const sessions = results.assignments[day] || [];
          const hasAnyContent = sessions.some(s => s.committees.length > 0);
          if (!hasAnyContent) return null;
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
                    {/* Per-session standby inline */}
                    {session.standbys && session.standbys.length > 0 && (
                      <div style={{ marginTop: 8, background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 8, padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: '#f59e0b' }}>📍 Standby:</span>
                        <span style={{ fontSize: 13, color: 'var(--text)' }}>
                          {session.standbys.map((s, i) => <span key={s.id}>{i > 0 && ' , '}{s.name}</span>)}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
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
      if (!supFormName.trim()) { showToast('Name is required', 'error'); return; }
      if (!editingSupId && !supFormPass.trim()) { showToast('Password is required for new users', 'error'); return; }
      if (editingSupId && changeSupPass && !supFormPass.trim()) { showToast('Enter the new password', 'error'); return; }
      try {
        const res = await fetch('/api/supervisors', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: editingSupId, name: supFormName.trim(), password: (!editingSupId || changeSupPass) ? supFormPass : '', permissions: supFormPermissions })
        });
        if (res.ok) {
          const data = await res.json();
          setSupervisors(data.supervisors);
          logAudit(editingSupId ? 'user_edited' : 'user_added', `${editingSupId ? 'Edited' : 'Added'} supervisor: ${supFormName.trim()}`);
          showToast(editingSupId ? 'User updated' : 'User added', 'success');
          setSupFormName(''); setSupFormPass(''); setEditingSupId(null); setSupFormPermissions([]); setChangeSupPass(false);
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
              <label className="form-label">
                Password
                {editingSupId && (
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer', color: 'var(--accent)', marginLeft: 12, fontWeight: 500 }}>
                    <input
                      type="checkbox"
                      checked={changeSupPass}
                      onChange={e => { setChangeSupPass(e.target.checked); if (!e.target.checked) setSupFormPass(''); }}
                      style={{ width: 15, height: 15, accentColor: 'var(--accent)' }}
                    />
                    Change password
                  </label>
                )}
              </label>
              <input
                className="form-input"
                type={editingSupId ? 'password' : 'text'}
                value={supFormPass}
                onChange={e => setSupFormPass(e.target.value)}
                placeholder={editingSupId ? (changeSupPass ? 'Enter new password' : 'Leave blank to keep current') : 'Set password'}
                disabled={!!(editingSupId && !changeSupPass)}
                style={editingSupId && !changeSupPass ? { opacity: 0.4 } : undefined}
              />
            </div>
            <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
              <button className="btn btn-primary" onClick={saveSupervisor} style={{ flex: 1 }}>
                {editingSupId ? '✓ Update' : '+ Add User'}
              </button>
              {editingSupId && (
                <button className="btn btn-ghost" onClick={() => { setEditingSupId(null); setSupFormName(''); setSupFormPass(''); setSupFormPermissions([]); setChangeSupPass(false); }}>Cancel</button>
              )}
            </div>
          </div>
          <div style={{ marginTop: 12, padding: '12px 16px', background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 10, fontWeight: 600 }}>Access Permissions:</div>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              {['teachers', 'schedule', 'distribute', 'results', 'stats'].map(perm => (
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
                    {perm === 'teachers' ? 'Teachers Page' : perm === 'schedule' ? 'Schedule Page' : perm === 'distribute' ? 'Distribute Page' : perm === 'results' ? 'Results Page' : 'Statistics Page'}
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
                    <button className="action-btn edit-btn" onClick={() => { setEditingSupId(s.id); setSupFormName(s.name); setSupFormPass(''); setSupFormPermissions(s.permissions || []); setChangeSupPass(false); }}>Edit</button>
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
  const hasResults = !!(results?.assignments && results?.tracking);
  const pages: { key: Page; label: string; adminOnly: boolean; requiresResults?: boolean }[] = [
    { key: 'teachers', label: '👨‍🏫 Teachers', adminOnly: false },
    { key: 'schedule', label: '📅 Schedule', adminOnly: false },
    { key: 'distribute', label: '⚡ Distribute', adminOnly: false },
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
          {!isAdmin && <button className="btn btn-ghost" onClick={() => { setShowChangePassword(!showChangePassword); setChangePassError(''); setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); }}>🔑 Change Password</button>}
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

      {/* Change Password Modal */}
      {showChangePassword && !isAdmin && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setShowChangePassword(false)}>
          <div style={{ background: 'var(--surface)', borderRadius: 16, padding: 28, width: 380, maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 20, textAlign: 'center', color: 'var(--text)' }}>🔑 Change Password</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ position: 'relative' }}>
              <input
                type={showCurPass ? 'text' : 'password'}
                placeholder="Current Password"
                value={currentPassword}
                onChange={e => { setCurrentPassword(e.target.value); setChangePassError(''); }}
                style={{ padding: '12px 44px 12px 14px', borderRadius: 8, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 14, fontFamily: 'var(--sans)', outline: 'none', width: '100%' }}
                autoFocus
              />
              <button type="button" onClick={() => setShowCurPass(!showCurPass)} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text2)', padding: 4, lineHeight: 1 }}>{showCurPass ? '🙈' : '👁'}</button>
              </div>
              <div style={{ position: 'relative' }}>
              <input
                type={showNewPass ? 'text' : 'password'}
                placeholder="New Password"
                value={newPassword}
                onChange={e => { setNewPassword(e.target.value); setChangePassError(''); }}
                style={{ padding: '12px 44px 12px 14px', borderRadius: 8, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 14, fontFamily: 'var(--sans)', outline: 'none', width: '100%' }}
              />
              <button type="button" onClick={() => setShowNewPass(!showNewPass)} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text2)', padding: 4, lineHeight: 1 }}>{showNewPass ? '🙈' : '👁'}</button>
              </div>
              <div style={{ position: 'relative' }}>
              <input
                type={showConfPass ? 'text' : 'password'}
                placeholder="Confirm New Password"
                value={confirmPassword}
                onChange={e => { setConfirmPassword(e.target.value); setChangePassError(''); }}
                onKeyDown={e => e.key === 'Enter' && handleChangePassword()}
                style={{ padding: '12px 44px 12px 14px', borderRadius: 8, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 14, fontFamily: 'var(--sans)', outline: 'none', width: '100%' }}
              />
              <button type="button" onClick={() => setShowConfPass(!showConfPass)} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text2)', padding: 4, lineHeight: 1 }}>{showConfPass ? '🙈' : '👁'}</button>
              </div>
              {changePassError && <p style={{ color: 'var(--danger)', fontSize: 12, margin: '-4px 0 0' }}>{changePassError}</p>}
              <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                <button
                  onClick={() => setShowChangePassword(false)}
                  style={{ flex: 1, padding: '12px 16px', borderRadius: 8, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text2)', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--sans)' }}
                >Cancel</button>
                <button
                  onClick={handleChangePassword}
                  style={{ flex: 1, padding: '12px 16px', borderRadius: 8, background: 'var(--accent)', border: 'none', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--sans)' }}
                >Update</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}