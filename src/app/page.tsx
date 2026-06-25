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
  const [isConnected, setIsConnected] = useState(true);
  const [userCanEditTeachers, setUserCanEditTeachers] = useState(false);

  // Data state
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [teacherOrder, setTeacherOrder] = useState<string[]>([]); // explicit order
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
        if (data && data.data) setResults(data.data);
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
    if (!password.trim()) { setLoginError('ادخل كلمة السر'); return; }
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
        setLoginError(data.message || 'كلمة السر غلط');
      }
    } catch { setLoginError('Connection error'); }
  };

  const handleLogout = () => {
    setView('login');
    setPassword('');
    setLoginError('');
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

  // ========== DISTRIBUTION ENGINE ==========
  const runDistribution = () => {
    if (teachers.length === 0) { showToast('Error: Registry empty!', 'error'); return; }

    const ruleSubject = (document.getElementById('rule-subject') as HTMLInputElement)?.checked ?? true;
    const ruleDayLimit = (document.getElementById('rule-daylimit') as HTMLInputElement)?.checked ?? true;
    const ruleNotes = (document.getElementById('rule-notes') as HTMLInputElement)?.checked ?? true;

    const tracking: Record<string, TrackingEntry> = {};
    teachers.forEach(t => {
      tracking[t.id] = { totalComm: 0, totalHours: 0, dayComm: {} as Record<string,number>, assignedSlots: [] };
      DAYS.forEach(d => { tracking[t.id].dayComm[d] = 0; });
    });

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

    fetch('/api/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: newResults }) });
    showToast('Overlap Lock Secured! Schedules fully cleared. ✓', 'success');
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
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 48, maxWidth: 440, width: '90%', textAlign: 'center' }}>
          <div style={{ width: 12, height: 12, background: 'var(--accent)', borderRadius: '50%', margin: '0 auto 16px', animation: 'pulse 2s infinite' }} />
          <h1 style={{ fontFamily: 'var(--mono)', fontSize: 16, color: 'var(--accent)', letterSpacing: 2, marginBottom: 8 }}>EXAM · SUPERVISOR</h1>
          <p style={{ color: 'var(--text2)', fontSize: 13, marginBottom: 32 }}>Exam Committee Distribution System</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <input
                type="password"
                placeholder="User Password"
                value={password}
                onChange={e => { setPassword(e.target.value); setLoginError(''); }}
                onKeyDown={e => e.key === 'Enter' && handleLogin('user')}
                style={{ padding: '12px 16px', borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 14, fontFamily: 'var(--sans)', outline: 'none', textAlign: 'center', width: '100%', marginBottom: 8 }}
              />
              <button
                onClick={() => handleLogin('user')}
                style={{ padding: '14px 24px', borderRadius: 10, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--sans)', transition: 'all 0.2s', width: '100%' }}
                onMouseOver={e => { (e.target as HTMLElement).style.borderColor = 'var(--accent)'; }}
                onMouseOut={e => { (e.target as HTMLElement).style.borderColor = 'var(--border)'; }}
              >
                👤 Enter as User
              </button>
            </div>
            <div style={{ color: 'var(--text2)', fontSize: 11, margin: '4px 0' }}>────── or ──────</div>
            <div>
              <input
                type="password"
                placeholder="Admin Password"
                value={password}
                onChange={e => { setPassword(e.target.value); setLoginError(''); }}
                onKeyDown={e => e.key === 'Enter' && handleLogin('admin')}
                style={{ padding: '12px 16px', borderRadius: 10, background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', fontSize: 14, fontFamily: 'var(--sans)', outline: 'none', textAlign: 'center', width: '100%', marginBottom: 8 }}
              />
              <button
                onClick={() => handleLogin('admin')}
                style={{ padding: '14px 24px', borderRadius: 10, background: 'var(--accent2)', border: 'none', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--sans)', transition: 'all 0.2s', width: '100%' }}
                onMouseOver={e => { (e.target as HTMLElement).style.background = '#e55a2b'; }}
                onMouseOut={e => { (e.target as HTMLElement).style.background = 'var(--accent2)'; }}
              >
                🔐 Enter as Admin
              </button>
            </div>
            {loginError && <p style={{ color: 'var(--danger)', fontSize: 12, margin: '-4px 0 0' }}>{loginError}</p>}
          </div>

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
        <div className="card-title" style={{ marginBottom: 16 }}>Mathematical Distribution Engine Constraints</div>
        <div className="grid-2">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" id="rule-subject" defaultChecked style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
              Block Specialty Subjects (Never supervise own exam)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" id="rule-daylimit" defaultChecked style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
              Enforce Hard Cap: **Strictly Max 1 Committee Per Day**
            </label>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" id="rule-notes" defaultChecked style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
              Match Stage Preferences Safely with Fallback (Eliminate Standby)
            </label>
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
        {DAYS.map(day => {
          const sessions = results.assignments[day] || [];
          if (sessions.length === 0) return null;
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
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // ========== STATS PAGE (Admin Only) ==========
  const renderStatsPage = () => {
    if (!results?.tracking || teachers.length === 0) return <div className="card"><div className="empty-state"><p>No analytics to track.</p></div></div>;

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
          <div className="stat-card"><span className="stat-number">{totalHrsAll.toFixed(1)}</span><div className="stat-label">Total Hours (All)</div></div>
          <div className="stat-card"><span className="stat-number">{(totalHrsAll / Math.max(teachers.length, 1)).toFixed(1)}</span><div className="stat-label">Avg Hours / Teacher</div></div>
          <div className="stat-card"><span className="stat-number">{maxHrs.toFixed(1)}</span><div className="stat-label">Max Hours (1 Teacher)</div></div>
          <div className="stat-card"><span className="stat-number" style={{ color: 'var(--danger)' }}>{over5Count}</span><div className="stat-label">Over 5h ⚠️</div></div>
          <div className="stat-card"><span className="stat-number" style={{ color: 'var(--warning)' }}>{notUsedCount}</span><div className="stat-label">Not Assigned</div></div>
        </div>
        <div className="card">
          <div className="card-title" style={{ marginBottom: 16 }}>Teacher Hours Summary</div>
          <div className="table-wrap" style={{ maxHeight: '70vh', overflow: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Teacher Name</th><th>Subject</th>
                  {DAYS.map(d => <th key={d}>{d.slice(0, 3)}</th>)}
                  <th style={{ background: 'rgba(0,212,255,0.1)' }}>Total<br/>Committees</th>
                  <th style={{ background: 'rgba(0,255,157,0.1)', minWidth: 100 }}>⏱ Total<br/>Hours</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((t, i) => {
                  const tt = tr[t.id] || { totalComm: 0, totalHours: 0, dayComm: {} };
                  const hrs = tt.totalHours || 0;
                  const pct = maxHrs > 0 ? Math.round(hrs / maxHrs * 100) : 0;
                  const hrsColor = hrs > 5 ? 'var(--danger)' : hrs > 3 ? 'var(--accent3)' : hrs > 0 ? 'var(--accent)' : 'var(--text2)';
                  const status = hrs === 0 ? <span className="badge" style={{ background: 'rgba(255,68,68,0.1)', color: 'var(--danger)' }}>Not Used</span>
                    : hrs > 5 ? <span className="badge" style={{ background: 'rgba(255,68,68,0.1)', color: 'var(--danger)' }}>Over 5h ⚠️</span>
                    : <span className="badge" style={{ background: 'rgba(0,255,157,0.1)', color: 'var(--accent3)' }}>OK ✓</span>;
                  return (
                    <tr key={t.id}>
                      <td style={{ color: 'var(--text2)' }}>{i + 1}</td>
                      <td style={{ fontWeight: 600, color: 'var(--text)' }}>{t.name}</td>
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
                  <td colSpan={3} style={{ color: 'var(--accent)', fontWeight: 700 }}>TOTAL</td>
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
  const hasResults = !!results?.tracking;
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
          EXAM · SUPERVISOR · TIME-LOCK · EQUALIZER · v9
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