import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/primitives';
import { EmptyState } from '@/components/states/states';

export function NotFoundPage() {
  return (
    <EmptyState
      title="לא נמצא"
      description="הכתובת המבוקשת לא קיימת או הוסרה."
      action={<Link to="/"><Button>חזרה לדשבורד</Button></Link>}
    />
  );
}
