// The engineer's tests for the ability system core. Synthesis runs them against the model's
// src/AbilitySystem.cpp in a sandbox; the model reads them but never writes them.
#include "lc_test.hpp"
#include "AbilitySystem.h"

using lc::AbilitySpec;
using lc::AbilitySystem;
using lc::ActivationResult;

static AbilitySpec fireball() {
  AbilitySpec spec;
  spec.id = "Fireball";
  spec.manaCost = 20.0f;
  spec.cooldownSeconds = 5.0;
  spec.blockedBy = {"Stunned", "Silenced"};
  spec.damage = 30.0f;
  return spec;
}

LC_TEST(unknown_abilities_cannot_activate) {
  AbilitySystem caster, target;
  LC_CHECK(!caster.HasAbility("Fireball"));
  LC_CHECK(caster.TryActivate("Fireball", target, 0.0) == ActivationResult::UnknownAbility);
  caster.Grant(fireball());
  LC_CHECK(caster.HasAbility("Fireball"));
}

LC_TEST(activation_pays_the_cost_once_and_damages_the_target) {
  AbilitySystem caster, target;
  caster.Grant(fireball());
  LC_CHECK(caster.TryActivate("Fireball", target, 0.0) == ActivationResult::Activated);
  LC_CHECK_NEAR(caster.Attributes().mana, 30.0f, 0.001f);
  LC_CHECK_NEAR(target.Attributes().health, 70.0f, 0.001f);
  LC_CHECK_NEAR(caster.Attributes().health, 100.0f, 0.001f);
}

LC_TEST(cooldown_blocks_until_it_elapses) {
  AbilitySystem caster, target;
  caster.Grant(fireball());
  LC_CHECK(caster.TryActivate("Fireball", target, 10.0) == ActivationResult::Activated);
  LC_CHECK(caster.TryActivate("Fireball", target, 12.0) == ActivationResult::OnCooldown);
  LC_CHECK_NEAR(caster.CooldownRemaining("Fireball", 12.0), 3.0, 0.0001);
  LC_CHECK_NEAR(caster.Attributes().mana, 30.0f, 0.001f);
  LC_CHECK(caster.TryActivate("Fireball", target, 15.0) == ActivationResult::Activated);
  LC_CHECK_NEAR(caster.CooldownRemaining("Fireball", 20.0), 0.0, 0.0001);
}

LC_TEST(blocking_tags_prevent_activation) {
  AbilitySystem caster, target;
  caster.Grant(fireball());
  caster.AddTag("Stunned");
  LC_CHECK(caster.HasTag("Stunned"));
  LC_CHECK(caster.TryActivate("Fireball", target, 0.0) == ActivationResult::Blocked);
  caster.RemoveTag("Stunned");
  LC_CHECK(!caster.HasTag("Stunned"));
  LC_CHECK(caster.TryActivate("Fireball", target, 0.0) == ActivationResult::Activated);
}

LC_TEST(a_failed_activation_changes_nothing) {
  AbilitySystem caster({100.0f, 100.0f, 10.0f, 50.0f}), target;
  caster.Grant(fireball());
  LC_CHECK(caster.TryActivate("Fireball", target, 0.0) == ActivationResult::NotEnoughMana);
  LC_CHECK_NEAR(caster.Attributes().mana, 10.0f, 0.001f);
  LC_CHECK_NEAR(target.Attributes().health, 100.0f, 0.001f);
  LC_CHECK_NEAR(caster.CooldownRemaining("Fireball", 0.0), 0.0, 0.0001);
  caster.RestoreMana(15.0f);
  LC_CHECK(caster.TryActivate("Fireball", target, 0.0) == ActivationResult::Activated);
}

LC_TEST(checks_run_in_the_contract_order) {
  AbilitySystem caster({100.0f, 100.0f, 25.0f, 50.0f}), target;
  caster.Grant(fireball());
  LC_CHECK(caster.TryActivate("Fireball", target, 0.0) == ActivationResult::Activated);
  caster.AddTag("Silenced");
  // On cooldown, blocked and out of mana at once: the cooldown is reported first.
  LC_CHECK(caster.TryActivate("Fireball", target, 1.0) == ActivationResult::OnCooldown);
  LC_CHECK(caster.TryActivate("Fireball", target, 6.0) == ActivationResult::Blocked);
  caster.RemoveTag("Silenced");
  LC_CHECK(caster.TryActivate("Fireball", target, 6.0) == ActivationResult::NotEnoughMana);
}

LC_TEST(attributes_stay_within_their_bounds) {
  AbilitySystem unit;
  unit.ApplyDamage(250.0f);
  LC_CHECK_NEAR(unit.Attributes().health, 0.0f, 0.001f);
  unit.ApplyDamage(-500.0f);
  LC_CHECK_NEAR(unit.Attributes().health, 100.0f, 0.001f);
  unit.RestoreMana(1000.0f);
  LC_CHECK_NEAR(unit.Attributes().mana, 50.0f, 0.001f);
  unit.RestoreMana(-1000.0f);
  LC_CHECK_NEAR(unit.Attributes().mana, 0.0f, 0.001f);
}

LC_TEST(a_dead_target_cannot_be_hit) {
  AbilitySystem caster, target;
  caster.Grant(fireball());
  target.ApplyDamage(100.0f);
  LC_CHECK(caster.TryActivate("Fireball", target, 0.0) == ActivationResult::TargetDead);
  LC_CHECK_NEAR(caster.Attributes().mana, 50.0f, 0.001f);
}

LC_TEST(granting_again_replaces_the_spec_and_its_cooldown) {
  AbilitySystem caster, target;
  caster.Grant(fireball());
  LC_CHECK(caster.TryActivate("Fireball", target, 0.0) == ActivationResult::Activated);
  AbilitySpec cheaper = fireball();
  cheaper.manaCost = 5.0f;
  cheaper.cooldownSeconds = 0.0;
  caster.Grant(cheaper);
  LC_CHECK(caster.TryActivate("Fireball", target, 1.0) == ActivationResult::Activated);
  LC_CHECK_NEAR(caster.Attributes().mana, 25.0f, 0.001f);
}
