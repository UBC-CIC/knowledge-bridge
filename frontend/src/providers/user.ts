import { createContext, useContext } from "react";

interface UserContextType {
  userId: string | null;
  isLoading: boolean;
  error: Error | null;
}

export const UserContext = createContext<UserContextType | undefined>(
  undefined
);




export function useUser() {
  const context = useContext(UserContext);
  if (context === undefined) {
    throw new Error("useUser must be used within a UserProvider");
  }
  return context;
}