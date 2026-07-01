import { NotFoundState } from '@/components/states/states';

export function NotFoundPage() {
  return (
    <NotFoundState
      title="דף לא נמצא"
      description="הכתובת המבוקשת לא קיימת או הוסרה."
      backTo="/"
      backLabel="חזרה לדשבורד"
    />
  );
}
