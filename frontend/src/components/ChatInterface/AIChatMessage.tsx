import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronDown, ChevronUp, BookOpen, ExternalLink, ThumbsUp, ThumbsDown, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import TypingIndicator from "./TypingIndicator";

const isSafeUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
};

const DISLIKE_CHIPS = ["Not helpful", "Inaccurate", "Off-topic", "Other"];

type MessageRating = { is_positive: boolean; comment: string | null };

type AIChatMessageProps = {
  text: string;
  sources?: any[];
  warning?: string | null;
  isTyping?: boolean;
  messageId?: string;
  isLastBotMessage?: boolean;
  existingRating?: MessageRating | null;
  onRate?: (messageId: string, is_positive: boolean, comment?: string) => Promise<void>;
};

export default function AIChatMessage({
  text,
  sources = [],
  warning = null,
  isTyping = false,
  messageId,
  isLastBotMessage = false,
  existingRating = null,
  onRate,
}: AIChatMessageProps) {
  const [showSources, setShowSources] = useState(false);
  const [ratingState, setRatingState] = useState<"idle" | "dislike-open" | "submitted">(
    existingRating !== null ? "submitted" : "idle"
  );
  const [submittedRating, setSubmittedRating] = useState<boolean | null>(
    existingRating?.is_positive ?? null
  );

  useEffect(() => {
    if (existingRating !== null) {
      setRatingState("submitted");
      setSubmittedRating(existingRating.is_positive);
    }
  }, [existingRating]);
  const [selectedChip, setSelectedChip] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const showRatingUI = isLastBotMessage && !isTyping && !!messageId && !!onRate;

  const handleThumbsUp = async () => {
    if (!messageId || !onRate) return;
    setSubmitting(true);
    await onRate(messageId, true);
    setSubmittedRating(true);
    setRatingState("submitted");
    setSubmitting(false);
  };

  const handleThumbsDown = () => {
    setRatingState("dislike-open");
  };

  const handleDislikeSubmit = async () => {
    if (!messageId || !onRate) return;
    setSubmitting(true);
    const comment = [selectedChip, commentText.trim()].filter(Boolean).join(" — ") || undefined;
    await onRate(messageId, false, comment);
    setSubmittedRating(false);
    setRatingState("submitted");
    setSubmitting(false);
  };

  const handleDislikeSkip = async () => {
    if (!messageId || !onRate) return;
    setSubmitting(true);
    await onRate(messageId, false);
    setSubmittedRating(false);
    setRatingState("submitted");
    setSubmitting(false);
  };

  const formatSource = (source: any) => {
    if (typeof source === "string") {
      // Check if source contains URL
      const urlMatch = source.match(/(https?:\/\/[^\s]+)/g);

      // Check if source contains page reference (p. X)
      const pageMatch = source.match(/\(p\.\s*(\d+)\)/i);

      if (urlMatch) {
        // Format URL sources
        return (
          <div className="flex flex-col w-full">
            <div className="flex items-center gap-1.5">
              <ExternalLink className="h-3 w-3 text-muted-foreground flex-shrink-0" />
              <span className="font-medium text-xs">Source link:</span>
            </div>
            <a
              href={isSafeUrl(urlMatch[0]) ? urlMatch[0] : "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline hover:text-primary/80 transition-colors break-words pl-4 text-xs"
              title={urlMatch[0]}
            >
              {urlMatch[0]}
            </a>
            {pageMatch && (
              <div className="pl-4 mt-1">
                <span className="text-muted-foreground text-xs font-medium">
                  Page: {pageMatch[1]}
                </span>
              </div>
            )}
          </div>
        );
      } else {
        // Format non-URL sources or other references
        return (
          <div className="flex flex-col w-full">
            <div className="flex items-center gap-1.5">
              <BookOpen className="h-3 w-3 text-muted-foreground flex-shrink-0" />
              <span className="font-medium text-xs">Source:</span>
            </div>
            <span className="text-muted-foreground break-words pl-4 text-xs">
              {source}
            </span>
          </div>
        );
      }
    }

    if (source && typeof source === "object") {
      const displayUrl = source.source_url || source.url || source.uri || "";
      const displayTitle = source.title || "";
      const displayContent = source.content || "";

      return (
        <div className="flex flex-col w-full gap-1.5">
          <div className="flex items-center gap-1.5">
            <BookOpen className="h-3 w-3 text-muted-foreground flex-shrink-0" />
            <span className="font-semibold text-xs text-foreground">{displayTitle || "Untitled"}</span>
          </div>
          {displayUrl && (
            <div className="flex items-center gap-1.5 pl-4">
              <ExternalLink className="h-3 w-3 text-primary flex-shrink-0" />
              <a
                href={isSafeUrl(displayUrl) ? displayUrl : "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline hover:text-primary/80 transition-colors text-xs break-all"
                title={displayUrl}
              >
                {displayUrl}
              </a>
            </div>
          )}
          {displayContent && (
            <div className="pl-4 mt-1 text-xs text-muted-foreground border-l-2 border-gray-200 ml-[5px]">
              {displayContent}
            </div>
          )}
        </div>
      );
    }

    return null;
  };

  return (
    <div className="flex justify-start">
      <Card className="py-[10px] w-full bg-transparent border-none shadow-none">
        <CardContent className="px-[10px] text-sm break-words">
          {isTyping ? (
            <TypingIndicator className="py-2" />
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSanitize, rehypeHighlight]}
              components={{
                // Headers
                h1: ({ ...props }) => (
                  <h1 className="text-xl font-bold mb-4 mt-6" {...props} />
                ),
                h2: ({ ...props }) => (
                  <h2 className="text-lg font-bold mb-3 mt-5" {...props} />
                ),
                h3: ({ ...props }) => (
                  <h3 className="text-base font-bold mb-2 mt-4" {...props} />
                ),
                h4: ({ ...props }) => (
                  <h4 className="text-sm font-bold mb-2 mt-4" {...props} />
                ),

                // Basic text elements
                p: ({ ...props }) => (
                  <p className="mb-4 last:mb-0" {...props} />
                ),

                // Lists
                ul: ({ ...props }) => (
                  <ul className="list-disc pl-5 mb-4" {...props} />
                ),
                ol: ({ ...props }) => (
                  <ol className="list-decimal pl-5 mb-4" {...props} />
                ),
                li: ({ ...props }) => <li className="mb-1" {...props} />,

                // Links
                a: ({ ...props }) => (
                  <a
                    {...props}
                    href={props.href && isSafeUrl(props.href) ? props.href : "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline"
                  />
                ),

                // Code
                code: ({ className, children, ...props }: any) => {
                  const match = /language-(\w+)/.exec(className || "");
                  const isInline = !match && props.inline;
                  return isInline ? (
                    <code
                      className="px-1 py-0.5 bg-muted rounded text-xs"
                      {...props}
                    >
                      {children}
                    </code>
                  ) : (
                    <code
                      className="block p-2 bg-muted rounded-md text-xs overflow-auto"
                      {...props}
                    >
                      {children}
                    </code>
                  );
                },
                pre: ({ ...props }) => (
                  <pre
                    className="bg-muted p-2 rounded-md overflow-auto text-xs my-2"
                    {...props}
                  />
                ),

                // Quotes
                blockquote: ({ ...props }) => (
                  <blockquote
                    className="pl-4 border-l-4 border-muted italic my-4"
                    {...props}
                  />
                ),

                // Horizontal Rule
                hr: () => <hr className="my-6 border-t border-muted" />,

                // Tables
                table: ({ ...props }) => (
                  <div className="overflow-x-auto">
                    <table
                      className="border-collapse border border-muted text-xs w-full my-4"
                      {...props}
                    />
                  </div>
                ),
                th: ({ ...props }) => (
                  <th
                    className="border border-muted px-2 py-1 bg-muted"
                    {...props}
                  />
                ),
                td: ({ ...props }) => (
                  <td className="border border-muted px-2 py-1" {...props} />
                ),

                // Images
                img: ({ ...props }) => (
                  <img
                    className="max-w-full h-auto my-4"
                    {...props}
                    alt={props.alt || ""}
                  />
                ),
              }}
            >
              {text}
            </ReactMarkdown>
          )}

          {!isTyping && sources && sources.length > 0 && (() => {
            // Filter out sources that look like S3 URLs (both https://s3... and s3://...)
            const renderableSources = sources.filter(source => {
              if (typeof source === "string") {
                return !source.includes("https://s3") && !source.includes("s3://");
              }
              const url = source?.url || source?.uri || "";
              return !url.includes("https://s3") && !url.includes("s3://");
            });

            if (renderableSources.length === 0) return null;

            return (
              <div className="mt-4 border-t border-muted pt-2">
                <Button
                  variant="link"
                  size="sm"
                  className="flex items-center gap-1 text-xs cursor-pointer text-muted-foreground hover:text-foreground"
                  onClick={() => setShowSources(!showSources)}
                >
                  <BookOpen className="h-3 w-3" />
                  {showSources ? "Hide sources" : "Show sources"} (
                  {renderableSources.length})
                  {showSources ? (
                    <ChevronUp className="h-3 w-3" />
                  ) : (
                    <ChevronDown className="h-3 w-3" />
                  )}
                </Button>

                {showSources && (
                  <div className="mt-3 w-full">
                    <p className="text-sm font-medium mb-2 text-foreground/80">
                      References:
                    </p>
                    <ul className="space-y-2 list-none pl-0 w-full">
                      {renderableSources.map((source, index) => (
                        <li
                          key={index}
                          className="w-full bg-white p-3 rounded-lg border border-gray-200 shadow-sm"
                        >
                          <div className="flex items-start gap-2">
                            <span className="text-xs font-bold text-primary mt-0.5 flex-shrink-0">{index + 1}</span>
                            <div className="flex-1 min-w-0">{formatSource(source)}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })()}

          {!isTyping && warning && (
            <div className="mt-4">
              <div className="rounded-lg border border-orange-300 bg-orange-50 px-3 py-2 text-sm text-orange-800 dark:border-orange-900/50 dark:bg-orange-950/40 dark:text-orange-200">
                {warning}
              </div>
            </div>
          )}

          {/* Rating UI */}
          {showRatingUI && (
            <div className="mt-3">
              {ratingState === "idle" && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={handleThumbsUp}
                    disabled={submitting}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-green-600 hover:bg-green-50 transition-colors disabled:opacity-40"
                    title="Good response"
                  >
                    <ThumbsUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={handleThumbsDown}
                    disabled={submitting}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
                    title="Bad response"
                  >
                    <ThumbsDown className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              {ratingState === "dislike-open" && (
                <div className="mt-1 rounded-xl border border-gray-200 bg-gray-50 p-3 space-y-3">
                  <p className="text-xs font-medium text-gray-700">What went wrong?</p>
                  <div className="flex flex-wrap gap-2">
                    {DISLIKE_CHIPS.map(chip => (
                      <button
                        key={chip}
                        type="button"
                        onClick={() => setSelectedChip(c => c === chip ? null : chip)}
                        className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                          selectedChip === chip
                            ? "bg-primary text-white border-primary"
                            : "bg-white text-gray-600 border-gray-200 hover:border-primary/50"
                        }`}
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                  <textarea
                    value={commentText}
                    onChange={e => setCommentText(e.target.value)}
                    placeholder="Add more detail (optional)…"
                    rows={2}
                    className="w-full text-xs px-3 py-2 border border-gray-200 rounded-lg bg-white resize-none focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
                  />
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      type="button"
                      onClick={handleDislikeSkip}
                      disabled={submitting}
                      className="text-xs text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-40"
                    >
                      Skip
                    </button>
                    <Button
                      size="sm"
                      onClick={handleDislikeSubmit}
                      disabled={submitting}
                      className="h-7 text-xs bg-primary text-white hover:bg-primary/90"
                    >
                      <Send className="h-3 w-3 mr-1" />Submit
                    </Button>
                  </div>
                </div>
              )}

              {ratingState === "submitted" && (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled
                    className={`p-1.5 rounded-md transition-colors ${
                      submittedRating === true
                        ? "text-green-600 bg-green-50"
                        : "text-red-500 bg-red-50"
                    }`}
                  >
                    {submittedRating === true
                      ? <ThumbsUp className="h-3.5 w-3.5" />
                      : <ThumbsDown className="h-3.5 w-3.5" />}
                  </button>
                  <span className="text-xs text-muted-foreground">Thanks for the feedback</span>
                </div>
              )}
            </div>
          )}

        </CardContent>
      </Card>
    </div>
  );
}
