// The engineer's interface for an engine-agnostic ability system core, in the spirit of Unreal's
// Gameplay Ability System. It is frozen in the contract: the model implements it in
// src/AbilitySystem.cpp and may not change it. Time comes from the caller, so the core stays
// deterministic and testable outside any engine.
#pragma once

#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace lc {

using Tag = std::string;

struct AttributeSet {
  float health = 100.0f;
  float maxHealth = 100.0f;
  float mana = 50.0f;
  float maxMana = 50.0f;
};

struct AbilitySpec {
  std::string id;
  float manaCost = 0.0f;
  double cooldownSeconds = 0.0;
  /** Activation fails while the owner has any of these tags (for example "Stunned"). */
  std::vector<Tag> blockedBy;
  /** Damage dealt to the target on activation; a negative value heals it. */
  float damage = 0.0f;
};

enum class ActivationResult { Activated, UnknownAbility, OnCooldown, Blocked, NotEnoughMana, TargetDead };

class AbilitySystem {
public:
  explicit AbilitySystem(AttributeSet attributes = {});

  /** Grants an ability; a spec with the same id replaces the previous one and its cooldown. */
  void Grant(const AbilitySpec& spec);
  bool HasAbility(const std::string& id) const;

  /** Checks, in this order: the ability is granted, it is off cooldown, no blocking tag is present,
   * there is enough mana, the target is alive (health above 0). The first failed check is returned
   * and nothing changes. On success the mana cost is paid once, the cooldown starts at `now`
   * (seconds), and the damage is applied to the target. */
  ActivationResult TryActivate(const std::string& id, AbilitySystem& target, double now);
  /** Seconds until the ability can be activated again: 0 when ready or unknown. */
  double CooldownRemaining(const std::string& id, double now) const;

  void AddTag(const Tag& tag);
  void RemoveTag(const Tag& tag);
  bool HasTag(const Tag& tag) const;

  /** Health and mana always stay within [0, max]. */
  void ApplyDamage(float amount);
  void RestoreMana(float amount);
  const AttributeSet& Attributes() const;

private:
  AttributeSet attributes_;
  std::unordered_map<std::string, AbilitySpec> abilities_;
  std::unordered_map<std::string, double> readyAt_;
  std::unordered_set<Tag> tags_;
};

}  // namespace lc
