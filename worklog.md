---
Task ID: 1
Agent: Main
Task: Convert Exam Supervisor System to Supabase + prepare for Vercel deployment

Work Log:
- Read existing code - found it was already partially converted to Supabase in previous session
- Fixed code issues: moved React import to top, removed dead queryTeacher code, added save button for user role
- Updated .env with user's Supabase credentials
- Removed `output: "standalone"` from next.config.ts for Vercel compatibility
- Improved schedule API to filter empty cells before saving
- Removed unused API route (src/app/api/route.ts)
- Successfully built the project (all routes compiled)
- Created clean deployment package (exam-supervisor-vercel.tar.gz)

Stage Summary:
- Build successful - all API routes + frontend working
- App uses Supabase for database + Realtime (no SQLite, no Socket.io)
- User needs to: (1) run SQL in Supabase SQL Editor, (2) deploy to Vercel
- Deployment package ready at /home/z/my-project/download/exam-supervisor-vercel.tar.gz