import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, LogIn } from 'lucide-react';
import { Button, Card, CardBody, Input } from '@/components/ui/primitives';
import { useAuth } from './AuthContext';
import { ApiError } from '@/types/api';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    try {
      await login(email.trim().toLowerCase(), password);
      navigate('/', { replace: true });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'הכניסה נכשלה');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardBody className="p-8">
          <div className="flex items-center gap-2 mb-6">
            <div className="h-10 w-10 rounded-lg bg-brand flex items-center justify-center text-white font-bold">ש</div>
            <div>
              <div className="text-lg font-bold">שדכנAI</div>
              <div className="text-xs text-ink-faint">Admin</div>
            </div>
          </div>

          <h1 className="text-xl font-semibold mb-1">כניסה</h1>
          <p className="text-sm text-ink-muted mb-6">הכניסה למערכת הניהול של שדכנAI</p>

          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1">אימייל</label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">סיסמה</label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
            </div>
            {err && (
              <div className="rounded-md bg-red-50 border border-red-200 text-red-700 text-sm p-3 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                {err}
              </div>
            )}
            <Button type="submit" loading={loading} leftIcon={<LogIn className="h-4 w-4" />} className="w-full">
              התחבר
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
