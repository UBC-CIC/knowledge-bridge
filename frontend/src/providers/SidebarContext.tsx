import { useState } from "react";
import type { ReactNode } from "react";
import SidebarContext from "./sidebar";

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const toggleMobile = () => setMobileOpen((prev) => !prev);

  return (
    <SidebarContext.Provider value={{ mobileOpen, toggleMobile, setMobileOpen }}>
      {children}
    </SidebarContext.Provider>
  );
}

export default SidebarProvider;

