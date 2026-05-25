import { createContext, useContext } from "react";

export type SidebarContextType = {
  mobileOpen: boolean;
  toggleMobile: () => void;
  setMobileOpen: (open: boolean) => void;
};

export const SidebarContext = createContext<SidebarContextType | undefined>(
  undefined
);

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within SidebarProvider");
  }
  return context;
}

export default SidebarContext;
