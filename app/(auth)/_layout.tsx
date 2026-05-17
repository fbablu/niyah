import { Stack } from "expo-router";
import { useColors } from "../../src/hooks/useColors";

export default function AuthLayout() {
  const colors = useColors();

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
        animation: "fade",
        animationDuration: 250,
      }}
    >
      <Stack.Screen name="welcome" />
      <Stack.Screen name="auth-entry" />
      <Stack.Screen name="phone-entry" />
      <Stack.Screen name="verify-phone" />
      <Stack.Screen name="check-email" />
      <Stack.Screen name="profile-setup" />
      <Stack.Screen name="intake" />
      <Stack.Screen name="how-it-works" />
      <Stack.Screen name="screen-time-math" />
      <Stack.Screen name="screentime-setup" />
      <Stack.Screen name="screentime-baseline" />
    </Stack>
  );
}
