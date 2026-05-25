import type { ReactNode } from "react";
import { ViewContext, type ViewContextType } from "./view";

export function ViewProvider({
  children,
  value
}: {
  children: ReactNode;
  value: ViewContextType
}) {
  return (
    <ViewContext.Provider value={value}>
      {children}
    </ViewContext.Provider>
  );
}
