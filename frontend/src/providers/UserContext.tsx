import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { fetchAuthSession } from "aws-amplify/auth";
import { UserContext } from "./user";

export function UserProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [role, setRole] = useState<"admin" | "users" | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const session = await fetchAuthSession();
        const idToken = session.tokens?.idToken;

        if (!idToken) {
          return;
        }

        const payload = idToken.payload;
        const sub = payload.sub as string;
        const userEmail = (payload.email as string) ?? null;
        const groups = (payload["cognito:groups"] as string[]) ?? [];
        const userRole: "admin" | "users" = groups.includes("admin") ? "admin" : "users";

        setUserId(sub);
        setEmail(userEmail);
        setRole(userRole);

        try {
          const token = idToken.toString();
          const res = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/user/${sub}`, {
            headers: { Authorization: token },
          });
          if (res.ok) {
            const data = await res.json();
            setDisplayName(data.display_name || userEmail);
          }
        } catch {
          // non-fatal — fall back to email
        }
      } catch (err) {
        setError(err instanceof Error ? err : new Error("Failed to load session"));
      } finally {
        setIsLoading(false);
      }
    };

    bootstrap();
  }, []);

  return (
    <UserContext.Provider value={{ userId, email, displayName, role, isLoading, error }}>
      {children}
    </UserContext.Provider>
  );
}
