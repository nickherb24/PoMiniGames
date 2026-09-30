namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// Picks controls for an AI official each tick: aim at a point ahead on the centerline,
/// offset to the official's preferred line, and hold a speed the next corner can take.
/// The AI drives through the same <see cref="PoCabinetPhysics.Step"/> as a player — it gets
/// throttle/brake/steer, never a position — so it obeys grip, grass and barriers.
///
/// <para>
/// Personality shapes the line, not the physics: <c>LateralOffset</c> is the lane it holds,
/// <c>LookaheadDistance</c> how early it turns in, <c>BrakingAggression</c> how hard it brakes
/// once over the corner speed, <c>CollisionTolerance</c> how little it swerves around a car
/// ahead, and <c>DraftingAffinity</c> how keenly it tucks in behind one.
/// </para>
/// <para>
/// Stateless and deterministic. <c>wwwroot/js/pocabinet/physics.js</c> (<c>aiControls</c>)
/// is the browser port the solo race and the demo autopilot use.
/// </para>
/// </summary>
public static class PoCabinetAiDriver
{
    public static PoCabinetControls Decide(
        PoCabinetTrack track,
        PoCabinetCarBody car,
        PoCabinetPersonality personality,
        double maxSpeed,
        double corneringSkill,
        IReadOnlyList<PoCabinetCarBody> field,
        double grip)
    {
        double v = car.Speed;
        double hw = track.HalfWidth;
        double lateralTarget = personality.LateralOffset * hw * 0.6;

        // Traffic: the nearest car ahead within 60 units of race distance.
        PoCabinetCarBody? ahead = null;
        double gap = double.MaxValue;
        foreach (var other in field)
        {
            if (ReferenceEquals(other, car)) continue;
            double d = other.Distance - car.Distance;
            if (d > 4 && d < 60 && d < gap)
            {
                gap = d;
                ahead = other;
            }
        }
        if (ahead is not null)
        {
            double latGap = ahead.Lateral - car.Lateral;
            if (personality.DraftingAffinity > 0.5 && gap > 22)
            {
                lateralTarget = ahead.Lateral; // tuck into the slipstream
            }
            else if (Math.Abs(latGap) < 24 && gap < 45)
            {
                // Swerve to the side with more room; a tolerant driver barely moves.
                double side = ahead.Lateral > 0 ? -1 : 1;
                lateralTarget += side * hw * 0.45 * (1 - personality.CollisionTolerance);
            }
        }
        lateralTarget = Math.Clamp(lateralTarget, -hw * 0.8, hw * 0.8);

        // Steering: aim at a point ahead, further ahead at speed.
        double look = personality.LookaheadDistance * 0.5 + 20 + Math.Abs(v) * 0.45;
        var p = track.PointAt(car.Along + look);
        double tx = p.X + -p.Ty * lateralTarget;
        double ty = p.Y + p.Tx * lateralTarget;
        double desired = Math.Atan2(ty - car.Y, tx - car.X);
        double err = PoCabinetTrack.WrapAngle(desired - car.Heading);
        double steer = Math.Clamp(err * 2.4, -1, 1);
        if (v < 0) steer = -steer; // rolling backwards inverts the lock (see PoCabinetPhysics.Step)

        // Speed: the tightest corner in braking range sets the target.
        double kappa = track.MaxCurvature(car.Along + 5, car.Along + 30 + Math.Abs(v) * 1.1);
        double margin = 0.55 + corneringSkill * 0.4;
        double cornerSpeed = Math.Sqrt(PoCabinetPhysics.GripAccel * grip * margin / Math.Max(kappa, 1e-5));
        double target = Math.Min(maxSpeed, cornerSpeed);
        if (ahead is not null && Math.Abs(ahead.Lateral - car.Lateral) < 20)
        {
            // Directly behind someone: close up, don't ram.
            target = Math.Min(target, Math.Max(0, ahead.Speed) + (gap - 18) * 1.5);
        }

        double throttle = v < target - 3 ? 1 : v < target ? 0.35 : 0;
        double brake = v > target + 4
            ? Math.Clamp((v - target) / 18 * (0.6 + personality.BrakingAggression * 0.8), 0.15, 1)
            : 0;
        return new PoCabinetControls(throttle, brake, steer);
    }
}
