import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronDown, ChevronUp, BookOpen, ExternalLink } from "lucide-react";
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

type AIChatMessageProps = {
  text: string;
  sources?: any[];
  warning?: string | null;
  isTyping?: boolean;
};

export default function AIChatMessage({
  text,
  sources = [],
  warning = null,
  isTyping = false,
}: AIChatMessageProps) {
  const [showSources, setShowSources] = useState(false);

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
      const { uri, url, content, type } = source;
      const displayUrl = url || uri;
      const displayContent = content || "";
      const isWeb = type === "WEB" || (displayUrl && displayUrl.startsWith("http"));

      return (
        <div className="flex flex-col w-full gap-1.5">
          {displayUrl && (
            <div className="flex items-start gap-1.5">
              {isWeb ? (
                <ExternalLink className="h-3 w-3 mt-0.5 text-muted-foreground flex-shrink-0" />
              ) : (
                <BookOpen className="h-3 w-3 mt-0.5 text-muted-foreground flex-shrink-0" />
              )}
              {isWeb ? (
                <a
                  href={isSafeUrl(displayUrl) ? displayUrl : "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline hover:text-primary/80 transition-colors text-xs font-medium break-all"
                  title={displayUrl}
                >
                  {displayUrl}
                </a>
              ) : (
                <span className="font-medium text-xs break-all">
                  {displayUrl}
                </span>
              )}
            </div>
          )}
          {displayContent && (
            <div className="text-xs text-muted-foreground pl-4 border-l-2 border-muted/50 ml-[5px] mt-1">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                {displayContent}
              </ReactMarkdown>
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
                    <ul className="space-y-4 list-none pl-0 w-full">
                      {renderableSources.map((source, index) => (
                        <li
                          key={index}
                          className="w-full bg-muted/30 p-2 rounded-md border border-muted"
                        >
                          {formatSource(source)}
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

        </CardContent>
      </Card>
    </div>
  );
}
