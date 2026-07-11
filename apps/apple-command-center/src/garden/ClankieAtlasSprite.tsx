import React, { useMemo } from "react";
import {
  Atlas,
  Canvas,
  FilterMode,
  MipmapMode,
  Skia,
  useImage,
  useRSXformBuffer,
} from "@shopify/react-native-skia";
import { StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useFrameCallback, useSharedValue, withSequence, withTiming } from "react-native-reanimated";

const CANVAS_WIDTH = 240;
const CANVAS_HEIGHT = 244;
const SPRITE_WIDTH = 192;
const SPRITE_HEIGHT = 224;
const BASE_SCALE = 0.72;

/**
 * Cross-lane choices forced by the Reanimated 3.19 / 4.5 skew:
 *
 * - Shared source imports only Reanimated itself. Reanimated 3 has no
 *   `react-native-worklets` package, so that module remains shell plumbing.
 * - `useSharedValue`, `.value`, `useFrameCallback`, `withTiming`, and
 *   `withSequence` are the common API. Reanimated 4-only CSS animations and
 *   transition APIs are intentionally excluded.
 * - Worklet directives are explicit. The desktop lane's Reanimated Babel
 *   plugin and the mobile lane's Worklets Babel plugin both recognize them.
 * - The frame callback writes SharedValues, and Skia's `useRSXformBuffer`
 *   mapper mutates the Atlas transform. React never receives a per-frame state
 *   update, so this path does not need to choose between Reanimated 3's
 *   `runOnJS` bridge and Reanimated 4's Worklets scheduling helpers.
 * - Skia must resolve beside each shell's Reanimated copy. Mobile's Metro
 *   blocklist enforces that pairing instead of bundling the shared package's
 *   Reanimated 3-backed Skia installation into the Reanimated 4 shell.
 */
export function ClankieAtlasSprite() {
  const image = useImage(require("../../../../assets/garden/clankie-green-x8.png"));
  const elapsed = useSharedValue(0);
  const tapPulse = useSharedValue(0);
  const tapLean = useSharedValue(1);
  const sprites = useMemo(() => [Skia.XYWHRect(0, 0, SPRITE_WIDTH, SPRITE_HEIGHT)], []);

  useFrameCallback(({ timeSinceFirstFrame }) => {
    "worklet";
    elapsed.value = timeSinceFirstFrame;
  });

  const transforms = useRSXformBuffer(1, (transform) => {
    "worklet";
    const scale = BASE_SCALE * (1 + tapPulse.value * 0.12);
    const bob = Math.sin(elapsed.value / 360) * 8;
    const angle = Math.sin(elapsed.value / 720) * 0.035 + tapLean.value * 0.025;
    const scos = scale * Math.cos(angle);
    const ssin = scale * Math.sin(angle);
    const sourceCenterX = SPRITE_WIDTH / 2;
    const sourceCenterY = SPRITE_HEIGHT / 2;
    const targetCenterX = CANVAS_WIDTH / 2;
    const targetCenterY = CANVAS_HEIGHT / 2 + bob;

    transform.set(
      scos,
      ssin,
      targetCenterX - scos * sourceCenterX + ssin * sourceCenterY,
      targetCenterY - ssin * sourceCenterX - scos * sourceCenterY,
    );
  });

  const tap = useMemo(
    () =>
      // GH 3 deprecates this builder in favor of useTapGesture, but the builder
      // is the only tap API shared with the mobile lane's GH 2.32.
      Gesture.Tap().onEnd((_event, success) => {
        "worklet";
        if (!success) {
          return;
        }
        tapPulse.value = withSequence(withTiming(1, { duration: 90 }), withTiming(0, { duration: 220 }));
        tapLean.value = withTiming(-tapLean.value, { duration: 240 });
      }),
    [tapLean, tapPulse],
  );

  return (
    <GestureDetector gesture={tap}>
      <View
        accessibilityHint="Makes the clankie bounce and lean the other way"
        accessibilityLabel="Animated green clankie"
        accessibilityRole="button"
        style={styles.touchTarget}
      >
        <Canvas style={styles.canvas}>
          <Atlas
            image={image}
            sampling={{ filter: FilterMode.Nearest, mipmap: MipmapMode.None }}
            sprites={sprites}
            transforms={transforms}
          />
        </Canvas>
        <View pointerEvents="none" style={styles.caption}>
          <Text style={styles.captionTitle}>UI-thread atlas sprite</Text>
          <Text style={styles.captionHint}>Tap to bounce</Text>
        </View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  touchTarget: {
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: "rgba(80, 111, 69, 0.35)",
    backgroundColor: "rgba(247, 250, 243, 0.78)",
    overflow: "hidden",
  },
  canvas: {
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
  },
  caption: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 9,
    alignItems: "center",
  },
  captionTitle: {
    color: "#253D2C",
    fontSize: 12,
    fontWeight: "800",
  },
  captionHint: {
    marginTop: 1,
    color: "#526052",
    fontSize: 11,
    fontWeight: "600",
  },
});
