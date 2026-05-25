export interface Message {
  id: string;
  sender: 'user' | 'bot';
  text: string;
  sources_used?: any[];
  time: number;
  isTyping?: boolean;
  isGuidedQuestion?: boolean;
  guidedData?: {
    templateId: string;
    questionIndex: number;
    totalQuestions: number;
  };
  warning?: string | null;
  hasPII?: boolean;
}