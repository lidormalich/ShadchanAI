import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './primitives';

export interface PaginationProps {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
  total?: number;
}

export function Pagination({ page, totalPages, onChange, total }: PaginationProps) {
  if (totalPages <= 1 && !total) return null;
  const canPrev = page > 1;
  const canNext = page < totalPages;

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border">
      <div className="text-xs text-ink-muted num">
        {total !== undefined ? `סה״כ ${total}` : ''} · עמוד {page} מתוך {totalPages}
      </div>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="secondary"
          disabled={!canPrev}
          onClick={() => onChange(Math.max(1, page - 1))}
          leftIcon={<ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />}
        >
          הקודם
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!canNext}
          onClick={() => onChange(Math.min(totalPages, page + 1))}
          rightIcon={<ChevronLeft className="h-3.5 w-3.5 rtl:rotate-180" />}
        >
          הבא
        </Button>
      </div>
    </div>
  );
}
