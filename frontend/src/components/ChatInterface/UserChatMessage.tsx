import { Card, CardContent } from "@/components/ui/card";

type UserChatMessageProps = {
  text: string;
  hasPII?: boolean;
};

export default function UserChatMessage({ text, hasPII }: UserChatMessageProps) {
  return (
    // main msg container
    <div className="flex flex-col items-end gap-1 group">
      <div className="flex justify-end w-full">
        <Card className="py-[10px] max-w-[90%]">
          <CardContent className="px-[10px] text-sm lg:text-md break-words">
            <p className="whitespace-pre-wrap">{text}</p>
          </CardContent>
        </Card>
      </div>
      {hasPII && (
        <p className="text-xs text-amber-500 pr-1">
          Your message may contain personal information. It will be redacted before saving.
        </p>
      )}
    </div>
  );
}
