import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { UserContext } from "./user";


export function UserProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const LOCAL_KEY = "specEx_user_session";

  useEffect(() => {
    const validateUser = async (stored: {
      userId: string;
      createdAt?: string;
    }) => {
      try {
        // get public token
        const tokenResp = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/user/publicToken`
        );
        if (!tokenResp.ok) {
          console.error("Failed to get public token");
          return false;
        };
        const { token } = await tokenResp.json();

        // Validate user exists
        const validateResp = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/user/${stored.userId}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        return validateResp.ok;
      } catch (e) {
        console.error("Error validating user:", e);
        return false;
      }
    };

    const createUser = async () => {
      try {
        // First get a public token
        const tokenResponse = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/user/publicToken`
        );
        if (!tokenResponse.ok) throw new Error("Failed to get public token");
        const { token } = await tokenResponse.json();

        // Create user
        const response = await fetch(`${import.meta.env.VITE_API_ENDPOINT}/user`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ role: "student" }), // Default to student on creation
        });

        if (!response.ok) {
          throw new Error("Failed to create user");
        }

        const data = await response.json();

        const id = data.userId
        if (!id) {
          throw new Error("Create user response missing user id");
        }

        const payload = {
          userId: id,
          createdAt: new Date().toISOString(),
        };

        try {
          localStorage.setItem(LOCAL_KEY, JSON.stringify(payload));
        } catch {
          console.warn("Failed to store user in localStorage");
        }

        setUserId(payload.userId);
      } catch (err) {
        setError(err instanceof Error ? err : new Error("Failed to create user"));
      } finally {
        setIsLoading(false);
      }
    };

    const bootstrap = async () => {
      try {
        const raw = localStorage.getItem(LOCAL_KEY);
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as {
              userId: string;
              createdAt?: string;
            };

            if (parsed.userId) {
              const ok = await validateUser(parsed);
              if (ok) {
                setUserId(parsed.userId);
                setIsLoading(false);
                return;
              }
            }
          } catch (e) {
            console.error("Error parsing stored user:", e);
            // parsing error — treat as missing
          }
        }

        // create a new user only if none valid
        await createUser();
      } catch (e) {
        setError(e instanceof Error ? e : new Error("Failed to initialize user"));
        setIsLoading(false);
      }
    };

    bootstrap();
  }, []); // Only run once when the app starts

  return (
    <UserContext.Provider value={{ userId, isLoading, error }}>
      {children}
    </UserContext.Provider>
  );
}
