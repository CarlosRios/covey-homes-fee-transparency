# Entrata Pricing API — Implementation Notes

Reference for wiring this fee-transparency site to live Entrata data instead of the static [fee_data.json](fee_data.json).

Source: [Entrata Developer Portal — Entrata APIs 1.0.0 (OAS 3.0)](https://developer.entrata.com/catalog/api/5471c3a8-e16f-3b80-93b3-006060e705db/documentation/830334cb-6491-3e1c-a696-5d1f25d1da63). Captured from the live portal on 2026-04-20.

> ⚠️ The legacy `docs.entrata.com/api/v1` RPC gateway was deprecated **April 15, 2025**. All public material from before that date (method names like `getUnitRentMatrixData`, subdomain-based URLs, Basic auth) is out of date. Everything below is from the new gateway spec.

---

## 1. Gateway basics

- **Base URL (US):** `https://apis.entrata.com/ext/orgs`
- **Base URL (EU):** `https://apis.entrata.global/ext/orgs`
- **Spec:** OpenAPI 3.0. The API is RPC-flavored — each resource area has a **single POST endpoint**, the method name lives in the request body.
- **Path shape:** `POST /{orgs}/v1/{resource}` where `{orgs}` is the client's Entrata subdomain (e.g. `coveyhomes`).
- **Content type:** `application/json` (request and response).
- **Time zone:** Mountain Time (MST/MDT) unless a field says otherwise.
- **Language:** optional `Accept-Language` header (`en-US`, `es-US`, `es-MX`, `hi-IN`, `zh-CN`, `fr-FR`, etc.).
- **Rate limits:** per service, per minute/hour/day. Limits come back in response headers — read them before scaling.

## 2. Authentication

- Type: **`apikey`** (not Basic).
- Access is provisioned per user by the client company — Covey's Entrata admin has to grant the integration user access to the Pricing resource.
- Request envelope always includes:
  ```json
  { "auth": { "type": "apikey" } }
  ```
- **Transport header:** `X-Api-Key: <key>` (confirmed from the OpenAPI `securitySchemes` block embedded in the portal page).

## 3. Envelope — every call looks like this

**Request:**
```json
{
  "auth":      { "type": "apikey" },
  "requestId": "15",
  "method": {
    "name":    "getPropertyFees",
    "version": "r1",
    "params":  { "propertyId": "12345" }
  }
}
```

**Success response:**
```json
{
  "response": {
    "requestId": "15",
    "code": 200,
    "result": { /* method-specific payload */ }
  }
}
```

**Error response:**
```json
{
  "response": {
    "requestId": "15",
    "error": { "code": 400, "message": "error message" }
  }
}
```

`requestId` is a client-generated echo field — use it to correlate async logs.

## 4. Pricing resource — `POST /{orgs}/v1/pricing`

Methods available on the `pricing` endpoint (exact list from the portal):

| Method | Purpose | Relevant to us? |
|---|---|---|
| `getPricingPicklists` | Reference data — pricing levels, charge usages, charge timings, charge code types | Yes (one-time lookup for labels/IDs) |
| **`getPropertyFees`** | All fees configured for a property (base, amenity, pet, add-ons, special) | **Primary method for fee transparency** |
| `insertPricing` | Write-side: push pricing data into Entrata | No (we're read-only) |
| `insertPricing(r2)` | Same, v2 | No |
| `sendBudgetedRent` | Write-side: push budget rent targets | No |

### 4a. `getPropertyFees` — the one we care about

**Request params:**
```json
{
  "propertyId": "12345"
}
```
Only `propertyId` is shown in the example. We'll confirm whether additional filters (floor plan, unit type, date) are supported once we can hit the sandbox.

**Response shape:** three parallel arrays keyed by cascade level.

```json
{
  "response": {
    "requestId": "15",
    "code": 200,
    "result": {
      "propertyFees":  [ /* fees applied at the property level */ ],
      "floorPlanFees": [ /* fees applied per floor plan */ ],
      "unitTypeFees":  [ /* fees applied per unit type */ ]
    }
  }
}
```

**Every fee row has the same shape.** Fields from the live example:

| Field | Meaning | Notes |
|---|---|---|
| `propertyId`, `propertyFloorplanId`, `unitTypeId`, `unitSpaceId` | Cascade keys | Empty string when not applicable at this level |
| `entrataCategoryId` / `entrataCategory` | Bucket: `Base`, `Amenity`, `Pet`, `Add Ons`, `Special` | From picklists |
| `associatedItemId` / `associatedItem` | Linked rentable item if any | e.g. a specific amenity |
| `cascadeId` / `cascadeReferenceId` / `cascadeReferenceName` | Which level this fee cascades from (1 Property, 2 Floor Plan, 3 Unit Type, 4 Space) | Matches `pricingLevels` picklist |
| `spaceConfigurationId` / `spaceConfiguration` | For student/per-bed setups | 0/empty for us most likely |
| `chargeCodeId` | Internal charge-code ID | |
| `chargeCodeName` | Human-readable name — e.g. "Application Fee", "Return Fee", "Accelerated Rent" | **Display this** |
| `chargeCodeDescription` | Long-form description | **Display this** |
| `chargeCodeGroupName` | Grouping label if any | |
| `leaseTermId` / `leaseTerm` / `leaseStartWindowId` / `termStartDate` / `termEndDate` | Lease-term scoping | `0`/`""` when fee applies to all terms |
| `chargeTimingId` / `chargeTiming` | **Frequency** — e.g. `Monthly` (307), `Move-In` (202), `One Time` (201), `Application Completed` (102), `Application Started` (106), `Move Out` (206), `Return Item Fee` (406) | Drives "per month" vs "one-time" labeling |
| `formulaId` / `formulaReferenceId` | Formula driving the amount (flat, % of rent, etc.) | `1` = flat amount in the example |
| `rateAmount` | Base rate for the formula | String, e.g. `"50.00"` |
| `rateIncreaseIncrement` | Escalator | `"0.0000"` for flat fees |
| `detailedAmount` | Resolved amount to charge the resident | **This is the number to display** |
| `isOptional` | `"0"` = mandatory, `"1"` = optional | **Drives mandatory vs. optional sections in the UI** |
| `isRefundable` | `"0"` / `"1"` | **Display "Refundable" vs "Non-refundable"** |
| `customerRelationshipId` / `customerRelationshipName` | Who pays — e.g. "Primary" | |

All IDs/flags come back as strings, not numbers.

### 4b. `getPricingPicklists` — do this once, cache it

Returns the enum tables used everywhere in Pricing responses:

- `pricingLevels`: `1 Property`, `2 Floor Plan`, `3 Unit Type`, `4 Space`
- `chargeUsages`: `1 Base`, `2 Amenity`, `3 Pet`, `4 Add Ons`, `6 Special`
- `chargeTimings`: `102 Application Completed`, `106 Application Started`, `201 One Time`, `202 Move In`, `206 Move Out`, `307 Monthly` (+ others like `406 Return Item Fee` seen in fee responses)
- `chargeCodeTypes`: `2 Rent`, `3 Other Income`, `4 Expense`, `5 Asset`, `6 Equity`, `7 Deposit`, `9 Other Liability` — each with an `allowed_charge_timing_ids` list

We store this as a small static lookup in the repo; refresh quarterly.

## 5. Properties resource — `POST /{orgs}/v1/properties`

Full method list from the portal (20 methods):

`getAmenityReservations`, `getCalendarAvailability(r1)`, `getCalendarAvailability(r2)`, **`getFloorPlans`**, `getPetTypes`, **`getProperties`**, `getPropertyAddOns`, `getPropertyAnnouncements`, `getPropertyPickLists(r1)`, `getPropertyPickLists(r2)`, `getRentableItems`, `getReservableAmenities`, `getWebsites`, `getPhoneNumber`, `getPropertyMedia`, `sendFloorplans`, `sendRentableItems`, `sendPropertyMedia`, `updatePropertyMedia`, `deletePropertyMedia`.

Bold = what we need for fee transparency. Also likely useful: `getPetTypes` (for the Pets block), `getRentableItems` (parking, storage), `getPropertyPickLists(r2)` (enums).

### 5a. `getProperties` — property metadata block

**Request:**
```json
{
  "auth": { "type": "apikey" },
  "requestId": "15",
  "method": {
    "name": "getProperties",
    "params": {
      "propertyIds": "1234,5678",
      "propertyLookupCode": "1234",
      "showAllStatus": "1"
    }
  }
}
```

Params we'll use: `propertyIds` (comma-separated). `propertyLookupCode` / `showAllStatus` are optional.

**Response** returns `result.PhysicalProperty.Property[]`. Each property has:

| Field | Use for |
|---|---|
| `PropertyID` | Internal ID (matches `getPropertyFees` `propertyId`) |
| `MarketingName` | `property.name` |
| `Type` | e.g. "Apartment" — ignore |
| `webSite` | `property.website` |
| `Address.{Address, City, State, PostalCode, Country}` | `property.address` (join the parts) |
| `Address.Email` | Property contact email if we want it |
| `ShortDescription`, `LongDescription` | Marketing copy — can be strings or `{ "b": "..." }` objects (HTML-ish) |
| `PropertyHours.OfficeHours.OfficeHour[]` | Office hours per day (`Day`, `OpenTime`, `CloseTime`, `LunchStartTime`, `LunchEndTime`) — bonus data for the UI |
| `IsDisabled`, `IsFeaturedProperty` | Filter out disabled |
| `CustomKeysData.CustomKeyData[]` | Arbitrary KV metadata — might hold `phone` here if Covey stores it as a custom key |

**Gotcha:** phone doesn't appear as a top-level field in the example. We'll either pull it from `getPhoneNumber` (dedicated method) or from `CustomKeysData`. Confirm once we hit Covey's real data.

### 5b. `getFloorPlans` — floor plan metadata + market rent + deposit

**Request:**
```json
{
  "auth": { "type": "apikey" },
  "requestId": "15",
  "method": {
    "name": "getFloorPlans",
    "params": {
      "propertyId": 123456,
      "propertyFloorPlanIds": "12345,4567",
      "usePropertyPreferences": "1",
      "includeDisabledFloorplans": "1"
    }
  }
}
```

Only `propertyId` is strictly needed.

**Response:** `result.FloorPlans.FloorPlan` (object or array). Each floor plan has:

| Field | Use for |
|---|---|
| `Identification.IDValue` | Floorplan ID (matches `propertyFloorplanId` on fees) |
| `Name` | Floor plan name (e.g. "The Magnolia") |
| `PropertyId` | Parent property |
| `UnitTypes.UnitType[]` | Array of `{ @value: "2BHK", @attributes.Id }` — maps floor plans → unit types |
| `Room[]` with `RoomType: "Bedroom" \| "Bathroom"` + `Count` | **Bedroom / bathroom counts** — drives the 2BR/3BR labels |
| `SquareFeet.@attributes.{Min, Max}` | Sqft range |
| `MarketRent.@attributes.{Min, Max}` | Rent range (not the "effective" rent — just market) |
| `Deposit.Amount.ValueRange.@attributes.{Min, Max}` + `Deposit.@attributes.DepositType` | **Security deposit by floor plan** |
| `Amenity[].@attributes.AmenityType` | e.g. `AirConditioner`, `AdditionalStorage` |
| `File.{FileID, Src, Caption, Format, Width, Height}` | Floor plan image |
| `UnitCount`, `UnitsAvailable` | Inventory |
| `IsDisabled` | Filter |

**This is where we get `security_deposit.two_bedrooms` / `three_bedrooms`** — group `FloorPlan[]` by bedroom `Count` and take the deposit. Note the example uses `AmountType: "MonthMultiple"` — deposit can be expressed as a dollar amount or a rent multiplier. Handle both.

Weird XML-ism: pay attention to `@attributes` and `@value` — the API serializes XML attributes into those keys rather than flattening.

## 6. Property Units resource — `POST /{orgs}/v1/propertyunits`

Full method list from the portal (14 methods):

`getAmenities`, `getMitsPropertyUnits`, **`getPropertyUnits`**, `getSpecials(r1)` through `getSpecials(r4)`, **`getUnitsAvailabilityAndPricing`**, **`getUnitTypes`**, `sendAmenities`, `sendPropertyUnits`, `sendSpecialGroup`, `updateAmenities`, `updateSpecialGroup`.

Bold = useful for us. `getSpecials` (concessions) may also be worth surfacing to show residents "$500 off at signing" promos — optional v2.

### 6a. `getUnitTypes` — unit-type → rent by lease term

**Request:**
```json
{
  "auth": { "type": "apikey" },
  "requestId": "15",
  "method": { "name": "getUnitTypes", "params": { "propertyId": 12345 } }
}
```

**Response:** `result.property` block + `result.unitTypes.unitType[]`. Each unit type has:

| Field | Use for |
|---|---|
| `identificationType.idValue` | Unit type ID (matches `unitTypeId` on fees) |
| `name` | Human name |
| `floorplan.{id}.@attributes.Id` + `.@value` | Linked floor plan |
| `unitBedRooms` / `unitBathrooms` | Bed / bath counts |
| `minSquareFeet` / `maxSquareFeet` | Sqft range |
| `minMarketRent` / `maxMarketRent` | Market rent range |
| `rent.termRent[].@attributes.{leaseTerm, leaseTermName, rent, startDate, endtDate, spaceOption, isSoldOut}` | **Per-lease-term pricing** (note the typo: `endtDate`) |

**When to use:** if you want to drive the "2 BR / 3 BR" deposit breakdown off unit types instead of floor plans, this is the cleanest source. Also the answer to "what does rent actually cost for a 12-month lease" (the floor-plan `MarketRent` is a marketing range; `termRent` is per-term real).

### 6b. `getPropertyUnits` — individual units (with unitSpaces, rent, deposits, pets, amenities)

**Request:**
```json
{
  "auth": { "type": "apikey" },
  "requestId": "15",
  "method": {
    "name": "getPropertyUnits",
    "params": {
      "propertyIds": "12345,4567",
      "availableUnitsOnly": "1",
      "usePropertyPreferences": "0",
      "includeDisabledFloorplans": "0",
      "includeDisabledUnits": "0"
    }
  }
}
```

**Response:** `result.properties.property[].units.unit` (object or array). Each unit:

| Field | Use for |
|---|---|
| `id` | Unit ID |
| `unitNumber`, `buildingId`, `buildingName` | Address display |
| `floorplanId`, `floorplanName`, `unitTypeId`, `unitTypeName` | Cascade keys |
| `noOfBedrooms`, `noOfBathrooms`, `squareFeet` | Unit dimensions |
| `isFurnished`, `isCorportateRented` (sic), `numberOccupants`, `maxPets` | Policy flags |
| `unitAddress.{address, city, state, postalCode, country}` | Physical address |
| `unitSpaces.unitSpace` | Per-space pricing & availability (below) |
| `files.file[]` | Unit photos |
| `customKeysData` | KV metadata |

`unitSpaces.unitSpace` has:
- `availabilityStatus` (e.g. "Unoccupied"), `availableDate`, `makeReadyDate`
- `rent.minRent` / `maxRent` + `rent.termRent.{leaseTermId, leaseTermName, startDate, endDate, amount, isBestPrice}` — **actual rentable rate**
- `minDeposit` / `maxDeposit` — strings formatted as "6,000.00"
- `amenities.amenity[]` — included amenities
- `pets.pet` — `{ type, count, deposit, rent, fee, petCare, restrictions, description }` — **direct pet fee data**
- `rentableItems.rentableItem[]` — parking etc.
- `assignableItems.assignableItem[]`
- `services.service[]`

Pet fees appear in **two places**: here on the unit, and on `getPropertyFees` under `entrataCategory: "Pet"`. Use `getPropertyFees` as the canonical source (it's the fee-transparency-blessed path); use this response only to confirm.

### 6c. `getUnitsAvailabilityAndPricing` — availability calendar + rent per space

**Request:**
```json
{
  "auth": { "type": "apikey" },
  "requestId": "15",
  "method": {
    "name": "getUnitsAvailabilityAndPricing",
    "version": "r1",
    "params": {
      "propertyId": 1234,
      "floorplanId": 1234,
      "unitTypeId": 1234,
      "propertyUnitId": 1234,
      "availableUnitsOnly": "1",
      "unavailableUnitsOnly": "0",
      "skipPricing": "0",
      "showChildProperties": "1",
      "includeDisabledFloorplans": "1",
      "includeDisabledUnits": "1",
      "showUnitSpaces": "1",
      "useSpaceConfiguration": "0",
      "allowLeaseExpirationOverride": "1",
      "moveInStartDate": "MM/DD/YYYY",
      "moveInEndDate": "MM/DD/YYYY"
    }
  }
}
```

**Response:** two parallel objects.
- `result.Properties.Property.Floorplans.Floorplan[]` — per-floorplan `MarketRent`, `Deposit`, room breakdown, `UnitCount` / `UnitsAvailable`.
- `result.PropertyUnits.PropertyUnit[].UnitSpace` — per-space `TermRent.@attributes.{LeaseTermId, LeaseTerm, Rent, RateFrequency, IsWebVisible}` and `Deposit.@attributes.{MinDeposit, MaxDeposit}`, plus availability/status/area.

**When to use:** this is the right call if we ever want to show residents what a specific unit costs at a given move-in date. For the fee-transparency doc as currently scoped, this is nice-to-have — `getFloorPlans` + `getUnitTypes` + `getPropertyFees` already covers what's on the page today.

### 6d. Quick reference — which call answers which UI question

| UI need | Call |
|---|---|
| Property name / address / website | `getProperties` |
| Office hours | `getProperties` → `PropertyHours` |
| Bedroom counts for deposit breakdown | `getFloorPlans` → `Room[]` |
| Security deposit by floor plan / unit type | `getFloorPlans` → `Deposit` (or `getUnitTypes`) |
| Rent range | `getFloorPlans` → `MarketRent`, or `getUnitTypes` → `termRent` for per-term |
| Every fee (app fee, admin, pet fee, utility admin, bundle, situational) | **`getPropertyFees`** |
| Fee frequency / mandatory / refundable flags | `getPropertyFees` row |
| Live unit availability + rent by move-in date | `getUnitsAvailabilityAndPricing` |
| Pet policy (types, deposits) | `getPetTypes` (properties resource) + `getPropertyFees` pet category |
| Parking / storage items | `getRentableItems` (properties resource) |

## 7. Supporting endpoints (not expanded here yet)

- **`POST /{orgs}/v1/arcodes`** — charge code metadata if `chargeCodeDescription` isn't enough.
- **`POST /{orgs}/v1/leases`**, **`/applications`**, **`/leads`**, **`/customers`**, **`/maintenance`** — resident lifecycle; not needed for the public fee-transparency page.
- **`POST /{orgs}/v1/financial`**, **`/artransactions`**, **`/arpayments`** — back-office accounting; not needed.

## 8. Mapping API responses → current `fee_data.json`

Current shape in [fee_data.json](fee_data.json) → where it comes from:

| JSON key | Source |
|---|---|
| `property.name` | `getProperties` → `MarketingName` |
| `property.address` | `getProperties` → `Address.{Address, City, State, PostalCode}` joined |
| `property.phone` | `getPhoneNumber` (or `CustomKeysData` — TBD with Covey) |
| `property.website` | `getProperties` → `webSite` |
| `property.last_updated` | Build timestamp from the fetch script |
| `application_fees.application_fee` | `getPropertyFees` → `propertyFees[]` where `chargeCodeName = "Application Fee"` (`chargeTiming = Application Completed`) |
| `application_fees.administrative_fee` | `getPropertyFees` → `propertyFees[]` where `chargeCodeName = "Administrative Fee"` |
| `application_fees.security_deposit.two_bedrooms` / `three_bedrooms` | **Preferred:** `getFloorPlans` → group by `Room[RoomType=Bedroom].Count` → `Deposit.Amount.ValueRange`. Fallback: `getPropertyFees` → `unitTypeFees[]` where `chargeCodeType = Deposit` |
| `pets.one_time_pet_fee.*` | `getPropertyFees` → `propertyFees[]` where `entrataCategory = Pet` and `chargeTiming = One Time`/`Move In` |
| `pets.monthly_pet_rent` | `getPropertyFees` → `propertyFees[]` where `entrataCategory = Pet` and `chargeTiming = Monthly` |
| `pets.breed_restrictions` / `max_pets` / `weight_restriction` | `getPetTypes` (properties resource) or unit-level `maxPets` from `getPropertyUnits` |
| `utilities.utility_billing_admin_fee` | `getPropertyFees` → `chargeCodeName` matches "Utility Admin" (Monthly) |
| `utilities.internet_wifi` | `getPropertyFees` → `propertyFees[]` or `floorPlanFees[]` where `chargeCodeName` matches "Internet" (Monthly) |
| `livemore_bundle` | `getPropertyFees` → `entrataCategory = Add Ons` + bundle-specific charge code |
| `situational_fees.*` (late fee, NSF, lease violation, replacement key, additional fob, transfer, early termination) | `getPropertyFees` → `propertyFees[]` where `isOptional = "1"` OR `chargeTiming = Return Item Fee` |
| `rent_reporting` | **Not in Entrata.** Stays static or pulled from Homebody separately. |
| `parking` (dedicated spaces, types, rules) | `getRentableItems` (properties resource) for numbers; rules stay static |
| `qualifying_criteria`, `move_in_requirements`, `application_steps` | **Static** — property policy copy stays in the repo |

**Implication:** the API replaces *numbers + fee names*; narrative/policy copy stays hard-coded. Things like "credit card processing fee" that show as "Varies" today will either stay static or fall back to a static override if `getPropertyFees` doesn't surface them.

## 9. Implementation plan

Current site is static HTML + a JSON file served by GitHub Pages. Two paths:

### Option A — Build-time fetch (recommended)

1. `scripts/fetch-entrata.mjs` (Node, `node:fetch`, no deps) that:
   - Reads env from `.env`: `ENTRATA_BASE_URL`, `ENTRATA_API_KEY`, `ENTRATA_PROPERTY_ID_TALLAHASSEE`.
   - Calls in parallel: `pricing/getPropertyFees`, `properties/getProperties`, `properties/getFloorPlans`, `properties/getPetTypes`, `properties/getRentableItems`.
   - Calls `pricing/getPricingPicklists` only if the cached copy is older than 90 days.
   - Normalizes into the existing `fee_data.json` shape so the UI doesn't change.
   - Writes `fee_data.json` back to disk.
2. GitHub Actions workflow runs nightly + on manual dispatch, commits the updated JSON, Pages redeploys.
3. Credentials in Actions Secrets — **never** shipped to the browser.

Pros: no new infra, static deploy stays static. Cons: up to 24h stale.

### Option B — Runtime proxy

Cloudflare Worker / Vercel / Lambda holding the API key, exposing a public cached JSON endpoint the static site fetches. Needed only if numbers have to be near-real-time.

Pros: always fresh. Cons: new infra, hosting, secret management, CORS.

**Recommendation:** start with Option A.

## 10. Open questions — confirm before coding

1. ~~**Credentials:**~~ ✅ Have the API key + `{orgs} = stockbridgecapitalgroup`.
2. **`propertyId` for Tallahassee:** still needed. Covey admin can pull this from Entrata, or we call `getProperties` (no params) and look for "Tallahassee" in the list.
3. **Auth header name:** portal shows `apikey` as the auth *type* in the request body, but the transport header name (`X-API-Key`, `Authorization: ApiKey ...`, etc.) needs confirmation. First live call will fail with a clear error if we guess wrong.
4. **Sandbox:** does Entrata provide a test org, or do we go straight at production? Read-only calls on prod are low-risk, but worth asking.
5. **Rate limits:** read actual per-minute/hour/day numbers from the first live response headers and bake them into the fetch script's retry/backoff.
6. **Phone number source:** `getProperties` response example doesn't include a phone at the top level. Is it under `CustomKeysData`, or do we need `getPhoneNumber`? Try the latter first.
7. **Deposit source:** confirm whether Covey surfaces the 2BR/3BR deposit split on floor plans (`getFloorPlans`) vs. unit types (`getUnitTypes`) vs. `unitTypeFees[]` from `getPropertyFees`. Pick whichever has real data.
8. **Multi-property rollout:** v1 = Tallahassee only, or all Covey communities from the start? Changes the output: single `fee_data.json` vs. `fee_data/{propertyId}.json`.

## 11. Next steps

- [ ] Get Tallahassee `propertyId` (or discover it via `getProperties` against the live API).
- [ ] Make a first live call against `getPropertyFees` and paste a real (redacted) response into this doc — the live rows will tell us exactly which `chargeCodeName` values Covey uses so we can write the mapping rules without guessing.
- [ ] Write `scripts/fetch-entrata.mjs` + a GitHub Actions workflow (secrets: `ENTRATA_BASE_URL`, `ENTRATA_API_KEY`, `ENTRATA_PROPERTY_ID_TALLAHASSEE`).
- [ ] Decide on multi-property structure before adding the second community.
