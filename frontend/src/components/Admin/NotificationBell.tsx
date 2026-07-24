import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = {
  total: number;
  onClick: () => void;
};

export default function NotificationBell({ total, onClick }: Props) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative hover:bg-white/10 text-white"
      onClick={onClick}
      aria-label={`Notifications${total > 0 ? ` (${total})` : ""}`}
    >
      <Bell className="h-5 w-5 text-white" />
      {total > 0 && (
        <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
          {total > 99 ? "99+" : total}
        </span>
      )}
    </Button>
  );
}
